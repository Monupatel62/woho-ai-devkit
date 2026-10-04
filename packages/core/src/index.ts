export interface AIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface AIRequest {
  messages: AIMessage[];
  model?: string;
  temperature?: number;
}

export interface AIResponse {
  text: string;
  model?: string;
}

export interface AIProvider {
  readonly name: string;
  chat(request: AIRequest): Promise<AIResponse>;
}

export function createAI(provider: AIProvider) {
  return {
    provider,
    chat(request: AIRequest) {
      return provider.chat(request);
    }
  };
}
