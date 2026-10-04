import {
  AuthenticationError,
  InvalidRequestError,
  ModelNotFoundError,
  NetworkError,
  RateLimitError,
  type AIMessage,
  type AIProvider,
  type AIRequest,
  type AIResponse,
  type AIStreamChunk,
  type AIToolCall,
} from "@woho/core";

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  organization?: string;
}

interface ProviderResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> };
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const toMessages = (messages: AIMessage[]) =>
  messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.name ? { name: m.name } : {}),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    ...(m.toolCalls?.length ? {
      tool_calls: m.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    } : {}),
  }));

function mapError(status: number, body: string): Error {
  if (status === 401) return new AuthenticationError("Invalid provider API key");
  if (status === 429) return new RateLimitError("Provider rate limit exceeded");
  if (status === 404) return new ModelNotFoundError("Model was not found");
  if (status >= 400 && status < 500) return new InvalidRequestError(body || "Provider rejected the request");
  return new NetworkError(body || "Provider returned HTTP " + status);
}

function normalizeToolCalls(message: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } | undefined): AIToolCall[] {
  const calls = message?.tool_calls ?? [];
  return calls
    .filter((call) => Boolean(call.function?.name))
    .map((call, index) => ({
      id: call.id ?? "tool-call-" + (index + 1),
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    }));
}

export function createOpenAIProvider(options: OpenAIProviderOptions): AIProvider {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  if (!options.apiKey) throw new AuthenticationError("An API key is required");

  const requestBody = (request: AIRequest, stream = false) => ({
    model: request.model ?? options.defaultModel ?? "gpt-4o-mini",
    messages: toMessages(request.messages),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    ...(request.stop ? { stop: request.stop } : {}),
    ...(request.tools?.length ? {
      tools: request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters ?? { type: "object", properties: {} },
        },
      })),
    } : {}),
    ...(stream ? { stream: true } : {}),
  });

  const headers = () => ({
    "content-type": "application/json",
    authorization: "Bearer " + options.apiKey,
    ...(options.organization ? { "OpenAI-Organization": options.organization } : {}),
  });

  return {
    name: "openai",
    async chat(request: AIRequest): Promise<AIResponse> {
      let response: Response;
      try {
        response = await fetch(baseUrl + "/chat/completions", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(requestBody(request)),
          signal: request.signal,
        });
      } catch (error) {
        throw new NetworkError("Network request failed", error);
      }
      if (!response.ok) throw mapError(response.status, await response.text());

      const data = (await response.json()) as ProviderResponse;
      const choice = data.choices?.[0];
      const toolCalls = normalizeToolCalls(choice?.message);
      return {
        id: data.id ?? crypto.randomUUID(),
        model: data.model ?? request.model ?? options.defaultModel ?? "unknown",
        text: choice?.message?.content ?? "",
        finishReason: toolCalls.length ? "tool_call" : choice?.finish_reason === "length" ? "length" : choice?.finish_reason === "stop" ? "stop" : "unknown",
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: data.usage ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        } : undefined,
      };
    },
    async *stream(request: AIRequest): AsyncIterable<AIStreamChunk> {
      let response: Response;
      try {
        response = await fetch(baseUrl + "/chat/completions", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(requestBody(request, true)),
          signal: request.signal,
        });
      } catch (error) {
        throw new NetworkError("Network request failed", error);
      }
      if (!response.ok) throw mapError(response.status, await response.text());
      if (!response.body) throw new NetworkError("Provider returned no response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;
          try {
            const data = JSON.parse(payload) as ProviderResponse;
            const choice = data.choices?.[0];
            yield {
              id: data.id,
              model: data.model,
              text: choice?.delta?.content ?? "",
              finishReason: choice?.finish_reason === "length" ? "length" : choice?.finish_reason === "stop" ? "stop" : undefined,
            };
          } catch {
            // Ignore malformed SSE frames.
          }
        }
      }
    },
  };
}
