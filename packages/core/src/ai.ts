import type { AIConfig, AIRequest, AIResponse, AIStreamChunk, AIObservability } from "./types.js";
import { AIError, TimeoutError } from "./errors.js";
import { validateAIInput } from "./validation.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function redactRequest(request: AIRequest): AIRequest {
  return {
    ...request,
    messages: request.messages.map((message) => ({
      ...message,
      content: "[REDACTED]",
      toolCalls: message.toolCalls?.map((call) => ({ ...call, arguments: "[REDACTED]" })),
    })),
    tools: request.tools?.map((tool) => ({ ...tool, description: "[REDACTED]", parameters: undefined })),
  };
}

function validate(request: AIRequest) {
  if (!request.messages.length) throw new AIError("At least one message is required", "INVALID_REQUEST_ERROR");
  try { validateAIInput(request.messages); }
  catch (error) { throw new AIError(error instanceof Error ? error.message : String(error), "INVALID_REQUEST_ERROR"); }
}

function mergeSignals(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(external?.reason ?? new Error("Aborted"));
  if (external?.aborted) onAbort();
  else external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new TimeoutError()), timeoutMs);
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); external?.removeEventListener("abort", onAbort); } };
}

async function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Aborted");
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, abort]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function nextWithSignal<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  if (signal.aborted) throw signal.reason ?? new Error("Aborted");
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), abort]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class AIClient {
  readonly provider: AIConfig["provider"];
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly observability?: AIObservability;
  private readonly includeRequestContentInObservability: boolean;

  constructor(config: AIConfig) {
    this.provider = config.provider;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.retries = config.retries ?? 2;
    this.retryDelayMs = config.retryDelayMs ?? 250;
    this.observability = config.observability;
    this.includeRequestContentInObservability = config.includeRequestContentInObservability ?? false;
    if (typeof this.includeRequestContentInObservability !== "boolean") throw new AIError("includeRequestContentInObservability must be a boolean", "INVALID_CONFIG");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new AIError("timeoutMs must be a positive integer", "INVALID_CONFIG");
    if (!Number.isInteger(this.retries) || this.retries < 0) throw new AIError("retries must be a non-negative integer", "INVALID_CONFIG");
    if (!Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 0) throw new AIError("retryDelayMs must be a non-negative integer", "INVALID_CONFIG");
  }

  async chat(request: AIRequest): Promise<AIResponse> {
    validate(request);
    let attempt = 0;
    while (true) {
      const started = Date.now();
      await this.observability?.onEvent?.({ type: "request.start", request: this.includeRequestContentInObservability ? request : redactRequest(request), attempt });
      const merged = mergeSignals(request.signal, this.timeoutMs);
      try {
        if (merged.signal.aborted) throw merged.signal.reason ?? new Error("Aborted");
        const response = await awaitWithSignal(this.provider.chat({ ...request, signal: merged.signal }), merged.signal);
        await this.observability?.onEvent?.({ type: "request.success", response, attempt, durationMs: Date.now() - started });
        return response;
      } catch (error) {
        const normalized = merged.signal.aborted && !request.signal?.aborted ? new TimeoutError() : error;
        await this.observability?.onEvent?.({ type: "request.error", error: normalized, attempt, durationMs: Date.now() - started });
        const retryable = normalized instanceof AIError ? normalized.retryable : false;
        if (!retryable || attempt >= this.retries) throw normalized;
        attempt += 1;
        await sleep(this.retryDelayMs * 2 ** (attempt - 1), request.signal);
      } finally {
        merged.cleanup();
      }
    }
  }

  async *stream(request: AIRequest): AsyncIterable<AIStreamChunk> {
    validate(request);
    if (!this.provider.stream) throw new AIError("Provider does not support streaming", "STREAMING_NOT_SUPPORTED");
    const started = Date.now();
    await this.observability?.onEvent?.({ type: "stream.start", request: this.includeRequestContentInObservability ? request : redactRequest(request) });
    const merged = mergeSignals(request.signal, this.timeoutMs);
    try {
      if (merged.signal.aborted) throw merged.signal.reason ?? new Error("Aborted");
      const iterator = this.provider.stream({ ...request, signal: merged.signal })[Symbol.asyncIterator]();
      try {
        while (true) {
        let result: IteratorResult<AIStreamChunk>;
        try {
          result = await nextWithSignal(iterator, merged.signal);
        } catch (error) {
          if (merged.signal.aborted) {
            if (request.signal?.aborted) throw request.signal.reason ?? new Error("Aborted");
            throw new TimeoutError();
          }
          throw error;
        }
          if (result.done) break;
          await this.observability?.onEvent?.({ type: "stream.chunk", chunk: result.value });
          yield result.value;
        }
      } finally {
        await iterator.return?.();
      }
    } finally {
      await this.observability?.onEvent?.({ type: "stream.end", durationMs: Date.now() - started });
      merged.cleanup();
    }
  }
}

export function createAI(config: AIConfig): AIClient {
  return new AIClient(config);
}
