import { AIError, type AIClient, type AIMessage, type AIToolCall, type AIToolDefinition } from "@woho/core";

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

  constructor(ai: AIClient, options: AgentOptions) {
    this.ai = ai;
    this.name = options.name;
    this.instructions = options.instructions;
    this.tools = options.tools ?? [];
    this.maxSteps = options.maxSteps ?? 8;
    if (this.maxSteps < 1) throw new AIError("maxSteps must be at least 1", "INVALID_AGENT_CONFIG");
  }

  async run(input: string): Promise<AgentRunResult> {
    if (!input.trim()) throw new AIError("Agent input cannot be empty", "INVALID_AGENT_INPUT");

    const messages: AIMessage[] = [];
    const toolResults: Record<string, unknown> = {};
    const toolsByName = new Map(this.tools.map((tool) => [tool.name, tool]));

    if (this.instructions) messages.push({ role: "system", content: this.instructions });
    messages.push({ role: "user", content: input });

    for (let step = 1; step <= this.maxSteps; step += 1) {
      const response = await this.ai.chat({
        messages,
        tools: this.tools.length ? toolDefinitions(this.tools) : undefined,
      });

      const calls = response.toolCalls ?? [];
      messages.push({
        role: "assistant",
        content: response.text,
        ...(calls.length ? { toolCalls: calls } : {}),
      });

      if (!calls.length) {
        return { text: response.text, steps: step, messages, toolResults };
      }

      for (const call of calls) {
        const tool = toolsByName.get(call.name);
        if (!tool) {
          const error = { error: "Unknown tool: " + call.name };
          toolResults[call.id] = error;
          messages.push({ role: "tool", content: serializeToolResult(error), toolCallId: call.id, name: call.name });
          continue;
        }

        try {
          const result = await tool.execute(parseArguments(call.arguments));
          toolResults[call.id] = result;
          messages.push({ role: "tool", content: serializeToolResult(result), toolCallId: call.id, name: call.name });
        } catch (error) {
          const failure = { error: error instanceof Error ? error.message : String(error) };
          toolResults[call.id] = failure;
          messages.push({ role: "tool", content: serializeToolResult(failure), toolCallId: call.id, name: call.name });
        }
      }
    }

    throw new AIError("Agent exceeded maxSteps (" + this.maxSteps + ")", "AGENT_MAX_STEPS");
  }
}

export function createAgent(ai: AIClient, options: AgentOptions): Agent {
  return new Agent(ai, options);
}
