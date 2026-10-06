import { AIError } from "./errors.js";
import type { AIProvider, AIRequest, AIResponse, AIStreamChunk } from "./types.js";

export interface ModelRoute {
  readonly provider: AIProvider;
  readonly models?: readonly string[];
}

export interface ModelRouterOptions {
  readonly routes: readonly ModelRoute[];
  readonly defaultModel?: string;
  readonly fallbackOnError?: boolean;
  /** Reject explicit model names that have no configured route instead of silently routing elsewhere. */
  readonly rejectUnknownModel?: boolean;
}

export class ModelRouter implements AIProvider {
  readonly name = "woho-router";
  private readonly routes: readonly ModelRoute[];
  private readonly defaultModel?: string;
  private readonly fallbackOnError: boolean;
  private readonly rejectUnknownModel: boolean;

  constructor(options: ModelRouterOptions) {
    if (!options.routes.length) throw new AIError("At least one model route is required", "INVALID_CONFIG");
    this.routes = options.routes;
    this.defaultModel = options.defaultModel;
    this.fallbackOnError = options.fallbackOnError ?? true;
    this.rejectUnknownModel = options.rejectUnknownModel ?? true;
    if (typeof this.rejectUnknownModel !== "boolean") throw new AIError("rejectUnknownModel must be a boolean", "INVALID_CONFIG");
    const seen = new Set<string>();
    for (const route of this.routes) {
      if (!route.provider.name.trim()) throw new AIError("Provider name is required", "INVALID_CONFIG");
      for (const model of route.models ?? []) {
        if (seen.has(model)) throw new AIError("Duplicate model route: " + model, "INVALID_CONFIG");
        seen.add(model);
      }
    }
  }

  async chat(request: AIRequest): Promise<AIResponse> {
    const routes = this.select(request.model);
    let lastError: unknown;
    for (const route of routes) {
      try {
        return await route.provider.chat(request);
      } catch (error) {
        lastError = error;
        if (!this.fallbackOnError || request.signal?.aborted) throw error;
        if (!(error instanceof AIError) || !error.retryable) throw error;
      }
    }
    throw lastError ?? new AIError("No model route available", "NO_PROVIDER");
  }

  async *stream(request: AIRequest): AsyncIterable<AIStreamChunk> {
    const routes = this.select(request.model);
    let lastError: unknown;
    for (const route of routes) {
      if (!route.provider.stream) continue;
      let emitted = false;
      try {
        for await (const chunk of route.provider.stream(request)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        if (emitted) throw error;
        lastError = error;
        if (!this.fallbackOnError || request.signal?.aborted) throw error;
        if (!(error instanceof AIError) || !error.retryable) throw error;
      }
    }
    throw lastError ?? new AIError("No streaming model route available", "STREAMING_NOT_SUPPORTED");
  }

  private select(model?: string): readonly ModelRoute[] {
    if (!model && this.defaultModel) model = this.defaultModel;
    if (!model) return this.routes;
    const matching = this.routes.filter((route) => (route.models ?? []).includes(model!));
    if (matching.length) return matching;
    const named = this.routes.filter((route) => route.provider.name === model);
    if (named.length) return named;
    if (this.rejectUnknownModel) throw new AIError(`No route configured for model: ${model}`, "MODEL_NOT_FOUND");
    return this.routes;
  }
}

export function createModelRouter(options: ModelRouterOptions): ModelRouter {
  return new ModelRouter(options);
}
