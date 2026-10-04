import type { AIProvider, AIRequest, AIResponse, AIStreamChunk } from "./types.js";

export interface MockProviderOptions {
  response?: string;
  model?: string;
  delayMs?: number;
}

export function createMockProvider(options: MockProviderOptions = {}): AIProvider {
  const response = options.response ?? "Hello from WoHo AI DevKit";
  const model = options.model ?? "mock";
  return {
    name: "mock",
    async chat(_request: AIRequest): Promise<AIResponse> {
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      return { id: "mock-response", text: response, model, finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    },
    async *stream(_request: AIRequest): AsyncIterable<AIStreamChunk> {
      for (const word of response.split(" ")) yield { id: "mock-stream", text: word + " ", model };
      yield { id: "mock-stream", text: "", model, finishReason: "stop" };
    },
  };
}