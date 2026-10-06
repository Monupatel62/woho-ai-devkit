import { AIError, type AIClient, type AIMessage, type AIToolCall, type AIToolDefinition, type AIUsage, type PermissionAction, type PermissionPolicy, type PermissionRequest } from "@woho/core";
import { createConversation, type MemoryStore, type MemoryMessage, type MemorySummarizer } from "@woho/memory";
import type { MCPClient } from "@woho/mcp";
import type { ExecutionEvent } from "@woho/core";

export interface AgentToolExecutionContext {
  readonly runId?: string;
  readonly signal?: AbortSignal;
}

export interface AgentTool {
  name: string;
  description: string;
  capability?: string;
  action?: PermissionAction;
  /** Resolve the permission request from the actual tool input. */
  authorize?: (input: unknown) => PermissionRequest | Promise<PermissionRequest>;
  parameters?: Record<string, unknown>;
  execute(input: unknown, context?: AgentToolExecutionContext): Promise<unknown>;
}

export interface AgentContext {
  messages: AIMessage[];
  toolResults: Record<string, unknown>;
  step: number;
}

export interface AgentApprovalRequest {
  readonly runId?: string;
  /** Exact model tool-call identity requiring owner approval. */
  readonly callId: string;
  /** Durable approval request identity assigned by AgentRuntime. */
  readonly approvalId?: string;
  readonly tool: string;
  readonly capability: string;
  readonly action: PermissionAction;
  readonly input: unknown;
  readonly reason?: string;
}

export type AgentApprovalHandler = (request: AgentApprovalRequest) => boolean | Promise<boolean>;

export interface AgentExecutionCheckpoint {
  readonly step: number;
  readonly messages: readonly AIMessage[];
  /** A tool call that may have started; recovery must fail closed until reconciled. */
  readonly inFlightToolCallId?: string;
  readonly updatedAt: number;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  runId?: string;
  onEvent?: (event: ExecutionEvent) => void | Promise<void>;
  approval?: AgentApprovalHandler;
  /** Continue from a durable checkpoint without replaying the original user message. */
  checkpoint?: AgentExecutionCheckpoint;
  onCheckpoint?: (checkpoint: AgentExecutionCheckpoint) => void | Promise<void>;
}

export interface AgentOptions {
  name: string;
  id?: string;
  role?: string;
  capabilities?: string[];
  permissions?: PermissionPolicy;
  instructions?: string;
  tools?: AgentTool[];
  maxSteps?: number;
  memory?: MemoryStore;
  sessionId?: string;
  maxContextMessages?: number;
  maxContextChars?: number;
  memorySummarizer?: MemorySummarizer;
  memorySummaryThreshold?: number;
  maxToolResultChars?: number;
  /** Maximum tool calls accepted from a single model response. Defaults to 32. */
  maxToolCallsPerStep?: number;
  /** Maximum UTF-8 byte length of serialized tool-call arguments. Defaults to 256 KiB. */
  maxToolArgumentBytes?: number;
  toolTimeoutMs?: number;
  approval?: AgentApprovalHandler;
}

export interface AgentRunResult {
  text: string;
  steps: number;
  messages: AIMessage[];
  toolResults: Record<string, unknown>;
  usage?: AIUsage;
}

function toolDefinitions(tools: AgentTool[]): AIToolDefinition[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function parseArguments(value: string): unknown {
  if (!value.trim()) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AIError("Tool call arguments are not valid JSON", "INVALID_TOOL_ARGUMENTS");
  }
}

function validateToolParameters(tool: AgentTool, input: unknown): void {
  const schema = tool.parameters;
  if (!schema) return;
  if (schema.type && schema.type !== "object") throw new AIError("Tool parameters must use an object schema: " + tool.name, "INVALID_TOOL_CONFIG");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AIError("Tool input must be an object: " + tool.name, "INVALID_TOOL_ARGUMENTS");
  const value = input as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== "string" || !(key in value)) throw new AIError("Missing required tool parameter: " + String(key), "INVALID_TOOL_ARGUMENTS");
  }
  if (schema.additionalProperties === false && schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const key of Object.keys(value)) {
      if (!(key in (schema.properties as Record<string, unknown>))) throw new AIError("Unknown tool parameter: " + key, "INVALID_TOOL_ARGUMENTS");
    }
  }
}

async function runEvent(options: AgentRunOptions, event: ExecutionEvent): Promise<void> {
  await options.onEvent?.(event);
}

function serializeToolResult(value: unknown, maxChars: number): string {
  const suffix = "\n[tool result truncated]";
  const payloadLimit = Math.max(0, maxChars - suffix.length);
  if (typeof value === "string") {
    return value.length <= maxChars ? value : value.slice(0, payloadLimit) + suffix.slice(0, maxChars - payloadLimit);
  }

  const seen = new WeakSet<object>();
  let output = "";
  let truncated = false;

  const append = (text: string): void => {
    if (output.length >= payloadLimit) {
      truncated = true;
      return;
    }
    const remaining = payloadLimit - output.length;
    if (text.length > remaining) {
      output += text.slice(0, remaining);
      truncated = true;
      return;
    }
    output += text;
  };

  const write = (input: unknown, depth: number): void => {
    if (output.length >= payloadLimit) {
      truncated = true;
      return;
    }
    if (depth > 6) {
      append("[MaxDepth]");
      return;
    }
    if (input === null) return append("null");
    if (typeof input === "string") return append(JSON.stringify(input));
    if (typeof input === "number" || typeof input === "boolean") return append(String(input));
    if (typeof input === "bigint") return append(JSON.stringify(String(input)) + "n");
    if (typeof input === "undefined") return append("undefined");
    if (typeof input === "function" || typeof input === "symbol") return append("[" + typeof input + "]");
    if (seen.has(input)) return append("[Circular]");
    seen.add(input);

    if (Array.isArray(input)) {
      append("[");
      for (let i = 0; i < input.length && output.length < payloadLimit; i += 1) {
        if (i > 0) append(", ");
        write(input[i], depth + 1);
      }
      if (output.length < payloadLimit && input.length > 0 && truncated) append(", …");
      append("]");
      return;
    }

    append("{");
    let first = true;
    for (const key of Object.keys(input as Record<string, unknown>)) {
      if (output.length >= payloadLimit) break;
      if (!first) append(", ");
      first = false;
      append(JSON.stringify(key) + ": ");
      try {
        write((input as Record<string, unknown>)[key], depth + 1);
      } catch {
        append("[unreadable]");
      }
    }
    append("}");
  };

  try {
    write(value, 0);
  } catch {
    return "[tool result unavailable]".slice(0, maxChars);
  }
  return truncated ? output + suffix.slice(0, maxChars - output.length) : output;
}

function limitContext(history: MemoryMessage[], maxMessages?: number, maxChars?: number): MemoryMessage[] {
  let items = maxMessages === undefined ? [...history] : history.slice(-maxMessages);
  if (maxChars === undefined) return items;
  const selected: MemoryMessage[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item) continue;
    const cost = item.content.length + 1;
    if (selected.length > 0 && used + cost > maxChars) break;
    if (selected.length === 0 && cost > maxChars) {
      selected.unshift({ ...item, content: item.content.slice(-maxChars) });
      break;
    }
    selected.unshift(item);
    used += cost;
  }
  return selected;
}

export class Agent {
  readonly name: string;
  readonly id?: string;
  readonly role?: string;
  readonly capabilities: readonly string[];
  readonly instructions?: string;
  readonly tools: AgentTool[];
  readonly maxSteps: number;
  private readonly permissions?: PermissionPolicy;
  private readonly ai: AIClient;
  private readonly memory?: MemoryStore;
  private readonly sessionId?: string;
  private readonly maxContextMessages?: number;
  private readonly maxContextChars?: number;
  private readonly memorySummarizer?: MemorySummarizer;
  private readonly memorySummaryThreshold: number;
  private readonly maxToolResultChars: number;
  private readonly maxToolCallsPerStep: number;
  private readonly maxToolArgumentBytes: number;
  private readonly toolTimeoutMs?: number;
  private readonly approval?: AgentApprovalHandler;

  constructor(ai: AIClient, options: AgentOptions) {
    this.ai = ai;
    this.name = options.name;
    this.id = options.id;
    this.role = options.role;
    this.capabilities = [...(options.capabilities ?? [])];
    this.instructions = options.instructions;
    this.tools = options.tools ?? [];
    this.maxSteps = options.maxSteps ?? 8;
    this.memory = options.memory;
    this.sessionId = options.sessionId;
    this.permissions = options.permissions;
    this.maxContextMessages = options.maxContextMessages;
    this.maxContextChars = options.maxContextChars;
    this.memorySummarizer = options.memorySummarizer;
    this.memorySummaryThreshold = options.memorySummaryThreshold ?? 50;
    this.maxToolResultChars = options.maxToolResultChars ?? 50_000;
    this.maxToolCallsPerStep = options.maxToolCallsPerStep ?? 32;
    this.maxToolArgumentBytes = options.maxToolArgumentBytes ?? 256 * 1024;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.approval = options.approval;
    if (this.sessionId !== undefined && !this.sessionId.trim()) throw new AIError("sessionId cannot be empty", "INVALID_AGENT_CONFIG");
    if (!options.name.trim()) throw new AIError("Agent name is required", "INVALID_AGENT_CONFIG");
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) throw new AIError("maxSteps must be a positive integer", "INVALID_AGENT_CONFIG");
    if (this.maxContextMessages !== undefined && (!Number.isInteger(this.maxContextMessages) || this.maxContextMessages < 1)) throw new AIError("maxContextMessages must be a positive integer", "INVALID_AGENT_CONFIG");
    if (this.maxContextChars !== undefined && (!Number.isInteger(this.maxContextChars) || this.maxContextChars < 1)) throw new AIError("maxContextChars must be a positive integer", "INVALID_AGENT_CONFIG");
    if (!Number.isInteger(this.memorySummaryThreshold) || this.memorySummaryThreshold < 1) throw new AIError("memorySummaryThreshold must be a positive integer", "INVALID_AGENT_CONFIG");
    if (!Number.isInteger(this.maxToolResultChars) || this.maxToolResultChars < 1) throw new AIError("maxToolResultChars must be a positive integer", "INVALID_AGENT_CONFIG");
    if (!Number.isInteger(this.maxToolCallsPerStep) || this.maxToolCallsPerStep < 1) throw new AIError("maxToolCallsPerStep must be a positive integer", "INVALID_AGENT_CONFIG");
    if (!Number.isInteger(this.maxToolArgumentBytes) || this.maxToolArgumentBytes < 1) throw new AIError("maxToolArgumentBytes must be a positive integer", "INVALID_AGENT_CONFIG");
    if (this.toolTimeoutMs !== undefined && (!Number.isInteger(this.toolTimeoutMs) || this.toolTimeoutMs < 1)) throw new AIError("toolTimeoutMs must be a positive integer", "INVALID_AGENT_CONFIG");
    for (const tool of this.tools) {
      if (!tool.name.trim()) throw new AIError("Tool name is required", "INVALID_AGENT_CONFIG");
      if (tool.name !== tool.name.trim()) throw new AIError("Tool name cannot have surrounding whitespace: " + tool.name, "INVALID_AGENT_CONFIG");
      if (!tool.description.trim()) throw new AIError("Tool description is required: " + tool.name, "INVALID_AGENT_CONFIG");
    }
    const names = this.tools.map((tool) => tool.name.trim());
    if (new Set(names).size !== names.length) throw new AIError("Duplicate tool name", "INVALID_AGENT_CONFIG");
  }

  async run(input: string, runOptions: AgentRunOptions = {}): Promise<AgentRunResult> {
    if (!input.trim()) throw new AIError("Agent input cannot be empty", "INVALID_AGENT_INPUT");
    if (runOptions.signal?.aborted) throw runOptions.signal.reason ?? new AIError("Agent run aborted", "AGENT_ABORTED");

    const messages: AIMessage[] = runOptions.checkpoint ? [...runOptions.checkpoint.messages] : [];
    const toolResults: Record<string, unknown> = {};
    let usage: AIUsage | undefined;
    const toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]));

    const resumed = Boolean(runOptions.checkpoint);
    if (!resumed && this.instructions) messages.push({ role: "system", content: this.instructions });
    const conversation = !resumed && this.memory && this.sessionId ? createConversation({ sessionId: this.sessionId, store: this.memory }) : undefined;
    if (!resumed && conversation) {
      let history = await conversation.messages(this.maxContextMessages);
      if (this.memorySummarizer && history.length >= this.memorySummaryThreshold) {
        const summary = await this.memorySummarizer.summarize(history, { maxCharacters: this.maxContextChars ?? 4000 });
        if (summary.trim()) history = [{ role: "system", content: summary } as MemoryMessage];
      }
      messages.push(...limitContext(history, this.maxContextMessages, this.maxContextChars).map(({ role, content, metadata }) => ({
        role, content, ...(metadata?.name && typeof metadata.name === "string" ? { name: metadata.name } : {}),
        ...(metadata?.toolCallId && typeof metadata.toolCallId === "string" ? { toolCallId: metadata.toolCallId } : {}),
        ...(Array.isArray(metadata?.toolCalls) ? { toolCalls: metadata.toolCalls as AIToolCall[] } : {}),
      })));
    }
    if (!resumed) {
      const userMessage: AIMessage = { role: "user", content: input };
      messages.push(userMessage);
      if (conversation) await conversation.add({ id: `user-${Date.now()}-${Math.random()}`, role: "user", content: input, timestamp: Date.now() });
    }
    const initialStep = runOptions.checkpoint?.step ?? 0;

    for (let step = initialStep + 1; step <= this.maxSteps; step += 1) {
      const response = await this.ai.chat({
        messages,
        tools: this.tools.length ? toolDefinitions(this.tools) : undefined,
        signal: runOptions.signal,
      });

      if (response.usage) {
        usage = usage
          ? {
              inputTokens: usage.inputTokens + response.usage.inputTokens,
              outputTokens: usage.outputTokens + response.usage.outputTokens,
              totalTokens: usage.totalTokens + response.usage.totalTokens,
              cost: usage.cost && response.usage.cost && usage.cost.currency === response.usage.cost.currency
                ? { currency: usage.cost.currency, amount: usage.cost.amount + response.usage.cost.amount }
                : response.usage.cost ?? usage.cost,
            }
          : { ...response.usage, cost: response.usage.cost ? { ...response.usage.cost } : undefined };
      }
      const calls = response.toolCalls ?? [];
      if (calls.length > this.maxToolCallsPerStep) {
        throw new AIError("Agent exceeded maxToolCallsPerStep (" + this.maxToolCallsPerStep + ")", "AGENT_TOOL_CALL_LIMIT");
      }
      for (const call of calls) {
        if (typeof call.arguments !== "string" || Buffer.byteLength(call.arguments, "utf8") > this.maxToolArgumentBytes) {
          throw new AIError("Tool call arguments exceed maxToolArgumentBytes", "TOOL_ARGUMENTS_TOO_LARGE");
        }
      }
      const assistantMessage: AIMessage = {
        role: "assistant",
        content: response.text,
        ...(calls.length ? { toolCalls: calls } : {}),
      };
      messages.push(assistantMessage);
      if (conversation) await conversation.add({ id: `assistant-${Date.now()}-${step}`, ...assistantMessage, timestamp: Date.now() });
      if (runOptions.onCheckpoint) {
        await runOptions.onCheckpoint({ step, messages: [...messages], updatedAt: Date.now() });
      }

      if (!calls.length) {
        return { text: response.text, steps: step, messages, toolResults, ...(usage ? { usage } : {}) };
      }

      for (const call of calls) {
        const tool = toolsByName.get(call.name);
        if (!tool) {
          const error = { error: "Unknown tool: " + call.name };
          toolResults[call.id] = error;
          const toolMessage: AIMessage = { role: "tool", content: serializeToolResult(error, this.maxToolResultChars), toolCallId: call.id, name: call.name };
          messages.push(toolMessage);
          if (conversation) await conversation.add({ id: `tool-${call.id}`, ...toolMessage, timestamp: Date.now() });
          if (runOptions.onCheckpoint) {
            await runOptions.onCheckpoint({ step, messages: [...messages], updatedAt: Date.now() });
          }
          continue;
        }

        try {
          const parsed = parseArguments(call.arguments);
          validateToolParameters(tool, parsed);
          if (tool.capability || tool.authorize) {
            if (!this.permissions) {
              throw new AIError("Tool capability requires a permission policy: " + tool.name, "PERMISSION_POLICY_REQUIRED");
            }
            const permission = tool.authorize
              ? await tool.authorize(parsed)
              : { capability: tool.capability as string, action: tool.action ?? "execute" };
            if (!permission.capability || !permission.action) {
              throw new AIError("Tool authorization must return capability and action: " + tool.name, "INVALID_TOOL_CONFIG");
            }
            const decision = await this.permissions.check(permission);
            if (!decision.allowed) {
              if (decision.requiresApproval) {
                await runEvent(runOptions, { type: "run.waiting", runId: runOptions.runId ?? "agent-run", timestamp: Date.now(), data: { reason: "approval", tool: tool.name, capability: permission.capability, action: permission.action } });
                const approved = await (runOptions.approval ?? this.approval)?.({ runId: runOptions.runId, callId: call.id, tool: tool.name, capability: permission.capability, action: permission.action, input: parsed, reason: decision.reason });
                if (!approved) throw new AIError(decision.reason ?? "Tool action was not approved", "APPROVAL_REQUIRED");
              } else {
                throw new AIError(decision.reason ?? "Tool action denied by permission policy", "PERMISSION_DENIED");
              }
            }
          }
          if (runOptions.onCheckpoint) {
            await runOptions.onCheckpoint({ step, messages: [...messages], inFlightToolCallId: call.id, updatedAt: Date.now() });
          }
          await runEvent(runOptions, { type: "tool.started", runId: runOptions.runId ?? "agent-run", timestamp: Date.now(), data: { tool: tool.name, callId: call.id, step } });
          let result: unknown;
          const toolController = new AbortController();
          const abortFromRun = () => toolController.abort(runOptions.signal?.reason);
          if (runOptions.signal) {
            if (runOptions.signal.aborted) toolController.abort(runOptions.signal.reason);
            else runOptions.signal.addEventListener("abort", abortFromRun, { once: true });
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            if (this.toolTimeoutMs !== undefined) {
              timer = setTimeout(() => toolController.abort(new AIError("Tool execution timed out: " + tool.name, "TOOL_TIMEOUT")), this.toolTimeoutMs);
            }
            result = await tool.execute(parsed, { runId: runOptions.runId, signal: toolController.signal });
            if (toolController.signal.aborted) {
              throw toolController.signal.reason ?? new AIError("Tool execution aborted: " + tool.name, "TOOL_ABORTED");
            }
          } finally {
            if (timer) clearTimeout(timer);
            runOptions.signal?.removeEventListener("abort", abortFromRun);
          }
          toolResults[call.id] = result;
          await runEvent(runOptions, { type: "tool.completed", runId: runOptions.runId ?? "agent-run", timestamp: Date.now(), data: { tool: tool.name, callId: call.id, step, success: true } });
          const toolMessage: AIMessage = { role: "tool", content: serializeToolResult(result, this.maxToolResultChars), toolCallId: call.id, name: call.name };
          messages.push(toolMessage);
          if (conversation) await conversation.add({ id: `tool-${call.id}`, ...toolMessage, timestamp: Date.now() });
        } catch (error) {
          const errorCode = error instanceof AIError ? error.code : "TOOL_EXECUTION_ERROR";
          await runEvent(runOptions, { type: "tool.completed", runId: runOptions.runId ?? "agent-run", timestamp: Date.now(), data: { tool: tool.name, callId: call.id, step, success: false, errorCode } });
          const failure = { error: error instanceof AIError ? error.code : "TOOL_EXECUTION_ERROR" };
          toolResults[call.id] = failure;
          const toolMessage: AIMessage = { role: "tool", content: serializeToolResult(failure, this.maxToolResultChars), toolCallId: call.id, name: call.name };
          messages.push(toolMessage);
          if (conversation) await conversation.add({ id: `tool-${call.id}`, ...toolMessage, timestamp: Date.now() });
        }
      }
    }

    throw new AIError("Agent exceeded maxSteps (" + this.maxSteps + ")", "AGENT_MAX_STEPS");
  }
}

export async function createMCPAgentTools(client: MCPClient): Promise<AgentTool[]> {
  const definitions = await client.listTools();
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description ?? `MCP tool: ${definition.name}`,
    parameters: definition.inputSchema,
    execute: async (input: unknown) => {
      const result = await client.callTool(definition.name, input);
      if (result.isError) throw new AIError(`MCP tool failed: ${definition.name}`, "MCP_TOOL_ERROR");
      return result.content;
    },
  }));
}

export { createAISummarizer, type AISummarizerOptions } from "./summarizer.js";
export * from "./definition.js";
export * from "./runtime.js";
export * from "./execution-store.js";
export * from "./plan.js";
export * from "./specialized.js";
export * from "./delegation.js";

export function createAgent(ai: AIClient, options: AgentOptions): Agent {
  return new Agent(ai, options);
}

export * from "./platform.js";

export * from "./coding-loop.js";

export * from "./browser.js";

export * from "./project-context.js";
