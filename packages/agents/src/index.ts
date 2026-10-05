import { AIError, type AIClient, type AIMessage, type AIToolCall, type AIToolDefinition } from "@woho/core";
import { createConversation, type MemoryStore, type MemoryMessage, type MemorySummarizer } from "@woho/memory";
import type { MCPClient } from "@woho/mcp";

export interface AgentTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  execute(input: unknown): Promise<unknown>;
}

export interface AgentContext {
  messages: AIMessage[];
  toolResults: Record<string, unknown>;
  step: number;
}

export interface AgentOptions {
  name: string;
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
  toolTimeoutMs?: number;
}

export interface AgentRunResult {
  text: string;
  steps: number;
  messages: AIMessage[];
  toolResults: Record<string, unknown>;
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

function serializeToolResult(value: unknown, maxChars: number): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try { text = JSON.stringify(value); }
    catch { text = String(value); }
  }
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "
[tool result truncated]";
}

function limitContext(history: MemoryMessage[], maxMessages?: number, maxChars?: number): MemoryMessage[] {
  let items = maxMessages === undefined ? [...history] : history.slice(-maxMessages);
  if (maxChars === undefined) return items;
  const selected: MemoryMessage[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
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
  readonly instructions?: string;
  readonly tools: AgentTool[];
  readonly maxSteps: number;
  private readonly ai: AIClient;
  private readonly memory?: MemoryStore;
  private readonly sessionId?: string;
  private readonly maxContextMessages?: number;
  private readonly maxContextChars?: number;
  private readonly memorySummarizer?: MemorySummarizer;
  private readonly memorySummaryThreshold?: number;
  private readonly maxToolResultChars: number;
  private readonly toolTimeoutMs?: number;

  constructor(ai: AIClient, options: AgentOptions) {
    this.ai = ai;
    this.name = options.name;
    this.instructions = options.instructions;
    this.tools = options.tools ?? [];
    this.maxSteps = options.maxSteps ?? 8;
    this.memory = options.memory;
    this.sessionId = options.sessionId;
    this.maxContextMessages = options.maxContextMessages;
    this.maxContextChars = options.maxContextChars;
    this.memorySummarizer = options.memorySummarizer;
    this.memorySummaryThreshold = options.memorySummaryThreshold ?? 50;
    this.maxToolResultChars = options.maxToolResultChars ?? 50_000;
    this.toolTimeoutMs = options.toolTimeoutMs;
    if (this.sessionId !== undefined && !this.sessionId.trim()) throw new AIError("sessionId cannot be empty", "INVALID_AGENT_CONFIG");
    if (!options.name.trim()) throw new AIError("Agent name is required", "INVALID_AGENT_CONFIG");
    if (!Number.isInteger(this.maxSteps) || this.maxSteps < 1) throw new AIError("maxSteps must be a positive integer", "INVALID_AGENT_CONFIG");
    if (this.maxContextMessages !== undefined && (!Number.isInteger(this.maxContextMessages) || this.maxContextMessages < 1)) throw new AIError("maxContextMessages must be a positive integer", "INVALID_AGENT_CONFIG");
    if (this.maxContextChars !== undefined && (!Number.isInteger(this.maxContextChars) || this.maxContextChars < 1)) throw new AIError("maxContextChars must be a positive integer", "INVALID_AGENT_CONFIG");
    if (!Number.isInteger(this.memorySummaryThreshold) || this.memorySummaryThreshold < 1) throw new AIError("memorySummaryThreshold must be a positive integer", "INVALID_AGENT_CONFIG");
    if (!Number.isInteger(this.maxToolResultChars) || this.maxToolResultChars < 1) throw new AIError("maxToolResultChars must be a positive integer", "INVALID_AGENT_CONFIG");
    if (this.toolTimeoutMs !== undefined && (!Number.isInteger(this.toolTimeoutMs) || this.toolTimeoutMs < 1)) throw new AIError("toolTimeoutMs must be a positive integer", "INVALID_AGENT_CONFIG");
    for (const tool of this.tools) {
      if (!tool.name.trim()) throw new AIError("Tool name is required", "INVALID_AGENT_CONFIG");
      if (tool.name !== tool.name.trim()) throw new AIError("Tool name cannot have surrounding whitespace: " + tool.name, "INVALID_AGENT_CONFIG");
      if (!tool.description.trim()) throw new AIError("Tool description is required: " + tool.name, "INVALID_AGENT_CONFIG");
    }
    const names = this.tools.map((tool) => tool.name.trim());
    if (new Set(names).size !== names.length) throw new AIError("Duplicate tool name", "INVALID_AGENT_CONFIG");
  }

  async run(input: string): Promise<AgentRunResult> {
    if (!input.trim()) throw new AIError("Agent input cannot be empty", "INVALID_AGENT_INPUT");

    const messages: AIMessage[] = [];
    const toolResults: Record<string, unknown> = {};
    const toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]));

    if (this.instructions) messages.push({ role: "system", content: this.instructions });
    const conversation = this.memory && this.sessionId ? createConversation({ sessionId: this.sessionId, store: this.memory }) : undefined;
    if (conversation) {
      let history = await conversation.messages(this.maxContextMessages);
      if (this.memorySummarizer && history.length >= this.memorySummaryThreshold) {
        const summary = await this.memorySummarizer.summarize(history, { maxCharacters: this.maxContextChars ?? 4000 });
        if (summary.trim()) history = [{ role: "system", content: summary } as MemoryMessage];
      }
      messages.push(...limitContext(history, this.maxContextMessages, this.maxContextChars).map(({ role, content, name, toolCallId, toolCalls }) => ({
        role, content, ...(name ? { name } : {}), ...(toolCallId ? { toolCallId } : {}), ...(toolCalls ? { toolCalls } : {}),
      })));
    }
    const userMessage: AIMessage = { role: "user", content: input };
    messages.push(userMessage);
    if (conversation) await conversation.add({ id: `user-${Date.now()}-${Math.random()}`, role: "user", content: input, timestamp: Date.now() });

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const response = await this.ai.chat({
        messages,
        tools: this.tools.length ? toolDefinitions(this.tools) : undefined,
      });

      const calls = response.toolCalls ?? [];
      const assistantMessage: AIMessage = {
        role: "assistant",
        content: response.text,
        ...(calls.length ? { toolCalls: calls } : {}),
      };
      messages.push(assistantMessage);
      if (conversation) await conversation.add({ id: `assistant-${Date.now()}-${step}`, ...assistantMessage, timestamp: Date.now() });

      if (!calls.length) {
        return { text: response.text, steps: step, messages, toolResults };
      }

      for (const call of calls) {
        const tool = toolsByName.get(call.name);
        if (!tool) {
          const error = { error: "Unknown tool: " + call.name };
          toolResults[call.id] = error;
          const toolMessage: AIMessage = { role: "tool", content: serializeToolResult(error, this.maxToolResultChars), toolCallId: call.id, name: call.name };
          messages.push(toolMessage);
          if (conversation) await conversation.add({ id: `tool-${call.id}`, ...toolMessage, timestamp: Date.now() });
          continue;
        }

        try {
          const parsed = parseArguments(call.arguments);
          validateToolParameters(tool, parsed);
          let result: unknown;
          if (this.toolTimeoutMs === undefined) {
            result = await tool.execute(parsed);
          } else {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              result = await Promise.race([
                tool.execute(parsed),
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new AIError("Tool execution timed out: " + tool.name, "TOOL_TIMEOUT")), this.toolTimeoutMs);
                }),
              ]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          }
          toolResults[call.id] = result;
          const toolMessage: AIMessage = { role: "tool", content: serializeToolResult(result, this.maxToolResultChars), toolCallId: call.id, name: call.name };
          messages.push(toolMessage);
          if (conversation) await conversation.add({ id: `tool-${call.id}`, ...toolMessage, timestamp: Date.now() });
        } catch (error) {
          const failure = { error: error instanceof Error ? error.message : String(error) };
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

export function createAgent(ai: AIClient, options: AgentOptions): Agent {
  return new Agent(ai, options);
}
