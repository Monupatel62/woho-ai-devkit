export type Role = "system" | "user" | "assistant" | "tool";

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface AIToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AIMessage {
  role: Role;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: AIToolCall[];
}

export interface AIRequest {
  messages: AIMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  stop?: string[];
  tools?: AIToolDefinition[];
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
  toolCalls?: AIToolCall[];
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

export type AILogEvent =\n  | { type: "request.start"; request: AIRequest; attempt: number }\n  | { type: "request.success"; response: AIResponse; attempt: number; durationMs: number }\n  | { type: "request.error"; error: unknown; attempt: number; durationMs: number }\n  | { type: "stream.start"; request: AIRequest }\n  | { type: "stream.chunk"; chunk: AIStreamChunk }\n  | { type: "stream.end"; durationMs: number };\n\nexport interface AIObservability {\n  onEvent?(event: AILogEvent): void | Promise<void>;\n}\n\nexport interface AIConfig {
  provider: AIProvider;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}
