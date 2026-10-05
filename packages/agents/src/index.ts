import { AIError, type AIClient, type AIMessage, type AIToolCall, type AIToolDefinition } from "@woho/core";
import { createConversation, type MemoryStore, type MemoryMessage, type MemorySummarizer } from "@woho/memory";

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
    return value;
  }
}

function serializeToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
    if (this.sessionId !== undefined && !this.sessionId.trim()) throw new AIError("sessionId cannot be empty", "INVALID_AGENT_CONFIG");
    if (this.maxSteps < 1) throw new AIError("maxSteps must be at least 1", "INVALID_AGENT_CONFIG");
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
      messages.push(...history.map(({ role, content, name, toolCallId, toolCalls }) => ({
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
          const toolMessage: AIMessage = { role: "tool", content: serializeToolResult(error), toolCallId: call.id, name: call.name };
          messages.push(toolMessage);
          if (conversation) await conversation.add({ id: `tool-${call.id}`, ...toolMessage, timestamp: Date.now() });
          continue;
        }

        try {
          const result = await tool.execute(parseArguments(call.arguments));
          toolResults[call.id] = result;
          const toolMessage: AIMessage = { role: "tool", content: serializeToolResult(result), toolCallId: call.id, name: call.name };
          messages.push(toolMessage);
          if (conversation) await conversation.add({ id: `tool-${call.id}`, ...toolMessage, timestamp: Date.now() });
        } catch (error) {
          const failure = { error: error instanceof Error ? error.message : String(error) };
          toolResults[call.id] = failure;
          const toolMessage: AIMessage = { role: "tool", content: serializeToolResult(failure), toolCallId: call.id, name: call.name };
          messages.push(toolMessage);
          if (this.memory) await this.memory.add({ id: `tool-${call.id}`, ...toolMessage, timestamp: Date.now() });
        }
      }
    }

    throw new AIError("Agent exceeded maxSteps (" + this.maxSteps + ")", "AGENT_MAX_STEPS");
  }
}

export { createAISummarizer, type AISummarizerOptions } from "./summarizer.js";

export function createAgent(ai: AIClient, options: AgentOptions): Agent {
  return new Agent(ai, options);
}
