import type { AIProvider, AIRequest, AIResponse, AIStreamChunk } from "./types.js";

export interface MockProviderOptions {
  response?: string;
  model?: string;
  delayMs?: number;
  toolCall?: { id?: string; name: string; arguments?: string };
}

export function createMockProvider(options: MockProviderOptions = {}): AIProvider {
  const response = options.response ?? "Hello from WoHo AI DevKit";
  const model = options.model ?? "mock";
  let toolCallUsed = false;

  return {
    name: "mock",
    async chat(_request: AIRequest): Promise<AIResponse> {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options.toolCall && !toolCallUsed) {
        toolCallUsed = true;
        return {
          id: "mock-tool-call",
          text: "",
          model,
          finishReason: "tool_call",
          toolCalls: [{
            id: options.toolCall.id ?? "mock-call-1",
            name: options.toolCall.name,
            arguments: options.toolCall.arguments ?? "{}",
          }],
        };
      }
      return { id: "mock-response", text: response, model, finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    },
    async *stream(_request: AIRequest): AsyncIterable<AIStreamChunk> {
      for (const word of response.split(" ")) yield { id: "mock-stream", text: word + " ", model };
      yield { id: "mock-stream", text: "", model, finishReason: "stop" };
    },
  };
}
