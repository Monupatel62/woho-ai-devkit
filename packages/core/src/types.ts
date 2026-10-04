export type Role = "system" | "user" | "assistant" | "tool";

export interface AIMessage {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface AIRequest {
  messages: AIMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  signal?: AbortSignal;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type FinishReason = "stop" | "length" | "tool_call" | "content_filter" | "unknown";

export interface AIResponse {
  id: string;
  text: string;
  model: string;
  usage?: AIUsage;
  finishReason?: FinishReason;
}

export interface AIStreamChunk {
  id?: string;
  text: string;
  model?: string;
  usage?: AIUsage;
  finishReason?: FinishReason;
}

export interface AIProvider {
  readonly name: string;
  chat(request: AIRequest): Promise<AIResponse>;
  stream?(request: AIRequest): AsyncIterable<AIStreamChunk>;
}

export interface AIConfig {
  provider: AIProvider;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}