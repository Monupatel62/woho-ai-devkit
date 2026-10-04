import { AIError, type AIClient, type AIMessage } from "@woho/core";

export interface AgentTool {
  name: string;
  description: string;
  execute(input: unknown): Promise<unknown>;
}

export interface AgentContext {
  messages: AIMessage[];
  toolResults: Record<string, unknown>;
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
  }

  async run(input: string): Promise<AgentRunResult> {
    if (!input.trim()) throw new AIError("Agent input cannot be empty", "INVALID_AGENT_INPUT");
    const messages: AIMessage[] = [];
    if (this.instructions) messages.push({ role: "system", content: this.instructions });
    messages.push({ role: "user", content: input });

    const result = await this.ai.chat({ messages });
    messages.push({ role: "assistant", content: result.text });

    return {
      text: result.text,
      steps: 1,
      messages,
      toolResults: {},
    };
  }
}

export function createAgent(ai: AIClient, options: AgentOptions): Agent {
  return new Agent(ai, options);
}