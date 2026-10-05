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
  maxResponseBytes?: number;
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

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new NetworkError("Provider returned no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new NetworkError("Provider response exceeds maxResponseBytes");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
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
  if (!options.apiKey.trim()) throw new AuthenticationError("An API key is required");
  if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/localhost(?::\d+)?(?:\/|$)/i.test(baseUrl)) throw new InvalidRequestError("baseUrl must use HTTPS (localhost is allowed for development)");
  const maxResponseBytes = options.maxResponseBytes ?? 4 * 1024 * 1024;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) throw new InvalidRequestError("maxResponseBytes must be a positive integer");

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
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxResponseBytes) throw new NetworkError("Provider response exceeds maxResponseBytes");
      let body: string;
      try { body = await readBodyWithLimit(response, maxResponseBytes); }
      catch (error) { if (error instanceof NetworkError) throw error; throw new NetworkError("Failed to read provider response", error); }
      let data: ProviderResponse;
      try { data = JSON.parse(body) as ProviderResponse; }
      catch (error) { throw new NetworkError("Malformed provider JSON response", error); }
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

      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > maxResponseBytes) throw new NetworkError("Provider response exceeds maxResponseBytes");
      const reader = response.body.getReader();
      let receivedBytes = 0;
      const decoder = new TextDecoder();
      let buffer = "";
      const processLine = (line: string): AIStreamChunk | undefined => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return undefined;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return undefined;
        const data = JSON.parse(payload) as ProviderResponse;
        const choice = data.choices?.[0];
        return {
          id: data.id,
          model: data.model,
          text: choice?.delta?.content ?? "",
          finishReason: choice?.finish_reason === "length" ? "length" : choice?.finish_reason === "stop" ? "stop" : undefined,
        };
      };
      try {
        while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxResponseBytes) {
          await reader.cancel();
          throw new NetworkError("Provider stream exceeds maxResponseBytes");
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const chunk = processLine(trimmed);
            if (chunk) yield chunk;
          } catch (error) {
            throw new NetworkError("Malformed provider SSE frame", error);
          }
        }
      }
        if (buffer.trim()) {
        try {
          const chunk = processLine(buffer);
          if (chunk) yield chunk;
        } catch (error) {
          throw new NetworkError("Malformed provider SSE frame", error);
        }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    },
  };
}
