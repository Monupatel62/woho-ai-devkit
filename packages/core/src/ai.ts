import type { AIConfig, AIRequest, AIResponse, AIStreamChunk } from "./types.js";
import { AIError, TimeoutError } from "./errors.js";
import { validateAIInput } from "./validation.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    }, { once: true });
  });

function validate(request: AIRequest) {
  if (!request.messages.length) throw new AIError("At least one message is required", "INVALID_REQUEST_ERROR");
  try {
    validateAIInput(request.messages);
  } catch (error) {
    throw new AIError(error instanceof Error ? error.message : String(error), "INVALID_REQUEST_ERROR");
  }
}

function mergeSignals(external: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(external?.reason);
  external?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new TimeoutError()), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

export class AIClient {
  readonly provider: AIConfig["provider"];
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(config: AIConfig) {
    this.provider = config.provider;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.retries = config.retries ?? 2;
    this.retryDelayMs = config.retryDelayMs ?? 250;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new AIError("timeoutMs must be a positive integer", "INVALID_CONFIG");
    if (!Number.isInteger(this.retries) || this.retries < 0) throw new AIError("retries must be a non-negative integer", "INVALID_CONFIG");
    if (!Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 0) throw new AIError("retryDelayMs must be a non-negative integer", "INVALID_CONFIG");
  }

  async chat(request: AIRequest): Promise<AIResponse> {
    validate(request);
    let attempt = 0;
    while (true) {
      const merged = mergeSignals(request.signal, this.timeoutMs);
      try {
        return await this.provider.chat({ ...request, signal: merged.signal });
      } catch (error) {
        const normalized = merged.signal.aborted && !request.signal?.aborted ? new TimeoutError() : error;
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
    const merged = mergeSignals(request.signal, this.timeoutMs);
    try {
      for await (const chunk of this.provider.stream({ ...request, signal: merged.signal })) {
        if (merged.signal.aborted) {
          if (request.signal?.aborted) throw request.signal.reason ?? new Error("Aborted");
          throw new TimeoutError();
        }
        yield chunk;
      }
    } finally {
      merged.cleanup();
    }
  }
}

export function createAI(config: AIConfig): AIClient {
  return new AIClient(config);
}
