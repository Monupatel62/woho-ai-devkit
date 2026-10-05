import type { AIConfig, AIRequest, AIResponse, AIStreamChunk } from "./types.js";
import { AIError, TimeoutError } from "./errors.js";\nimport { validateAIInput } from "./validation.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function validate(request: AIRequest) {
  if (!request.messages.length) throw new AIError("At least one message is required", "INVALID_REQUEST_ERROR");\n  try { validateAIInput(request.messages); } catch (error) { throw new AIError(error instanceof Error ? error.message : String(error), "INVALID_REQUEST_ERROR"); }
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
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      } finally {
        merged.cleanup();
      }
    }
  }

  stream(request: AIRequest): AsyncIterable<AIStreamChunk> {
    validate(request);
    if (!this.provider.stream) throw new AIError("Provider does not support streaming", "STREAMING_NOT_SUPPORTED");
    return this.provider.stream(request);
  }
}

export function createAI(config: AIConfig): AIClient {
  return new AIClient(config);
}