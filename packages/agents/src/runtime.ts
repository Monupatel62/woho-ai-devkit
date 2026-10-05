import { randomUUID } from "node:crypto";
import type { AIClient, ExecutionContext, ExecutionEvent } from "@woho/core";
import { Agent, type AgentApprovalHandler, type AgentOptions, type AgentRunResult } from "./index.js";
import { AgentRegistry, type AgentDefinition } from "./definition.js";
import type { ExecutionStore } from "./execution-store.js";

export interface AgentRetryPolicy {
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly backoff?: number;
}

export interface AgentRuntimeOptions {
  readonly maxConcurrency?: number;
  readonly onEvent?: (event: ExecutionEvent) => void | Promise<void>;
  readonly retry?: AgentRetryPolicy;
  readonly approval?: AgentApprovalHandler;
  readonly store?: ExecutionStore;
}

export interface AgentTask {
  readonly agent: string;
  readonly input: string;
  readonly parentRunId?: string;
  readonly sessionId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly retry?: AgentRetryPolicy;
  readonly approval?: AgentApprovalHandler;
}

export class AgentRuntime {
  readonly registry: AgentRegistry;
  private readonly maxConcurrency: number;
  private readonly onEvent?: AgentRuntimeOptions["onEvent"];
  private readonly defaultRetry: Required<AgentRetryPolicy>;
  private readonly store?: ExecutionStore;
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal }> = [];

  constructor(options: AgentRuntimeOptions = {}, registry = new AgentRegistry()) {
    this.registry = registry;
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.onEvent = options.onEvent;
    this.defaultRetry = this.validateRetry(options.retry ?? {});
    this.store = options.store;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) throw new Error("maxConcurrency must be a positive integer");
  }

  register(definition: AgentDefinition, factory?: (ai: AIClient, definition: AgentDefinition) => Agent): this {
    const creator = factory ?? ((ai, item) => new Agent(ai, {
      name: item.name,
      instructions: item.instructions,
      tools: item.tools,
      maxSteps: item.maxSteps,
      id: item.id,
      role: item.role,
      capabilities: item.capabilities,
      permissions: item.permissions,
    }));
    this.registry.register(definition, ({ ai }) => creator(ai, definition));
    return this;
  }

  async run(ai: AIClient, task: AgentTask): Promise<AgentRunResult & { runId: string }> {
    const runId = randomUUID();
    const retry = this.validateRetry(task.retry ?? this.defaultRetry);
    await this.acquire(task.signal);
    const context: ExecutionContext = {
      runId,
      sessionId: task.sessionId,
      parentRunId: task.parentRunId,
      signal: task.signal,
      metadata: task.metadata ?? {},
    };
    const startedAt = Date.now();
    await this.store?.create({ runId, agent: task.agent, parentRunId: task.parentRunId, sessionId: task.sessionId, metadata: task.metadata ?? {}, status: "running", startedAt, updatedAt: startedAt, attempts: 0, events: [] });
    await this.emit({ type: "run.started", runId, timestamp: startedAt, data: { agent: task.agent, sessionId: task.sessionId } });

    try {
      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        try {
          if (task.signal?.aborted) throw task.signal.reason ?? new Error("Aborted");
          await this.store?.update(runId, { attempts: attempt, status: "running", updatedAt: Date.now() });
          const agent = this.registry.create(task.agent, ai);
          const result = await agent.run(task.input, { signal: context.signal, runId, onEvent: this.onEvent, approval: task.approval });
          await this.store?.update(runId, { status: "succeeded", attempts: attempt, completedAt: Date.now(), updatedAt: Date.now() });
          await this.emit({
            type: "run.completed",
            runId,
            timestamp: Date.now(),
            data: { agent: task.agent, steps: result.steps, attempts: attempt },
          });
          return { ...result, runId };
        } catch (error) {
          if (task.signal?.aborted) throw error;
          if (attempt >= retry.maxAttempts) throw error;
          const delay = retry.delayMs * Math.pow(retry.backoff, attempt - 1);
          await this.store?.update(runId, { status: "waiting", attempts: attempt, updatedAt: Date.now() });
          await this.emit({
            type: "run.waiting",
            runId,
            timestamp: Date.now(),
            data: { agent: task.agent, attempt, nextAttempt: attempt + 1, delayMs: delay },
          });
          await this.sleep(delay, task.signal);
        }
      }
      throw new Error("Agent runtime exhausted retry loop");
    } catch (error) {
      if (task.signal?.aborted) {
        await this.store?.update(runId, { status: "cancelled", completedAt: Date.now(), updatedAt: Date.now() });
        await this.emit({ type: "run.cancelled", runId, timestamp: Date.now(), data: { agent: task.agent } });
      } else {
        await this.store?.update(runId, { status: "failed", completedAt: Date.now(), updatedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
        await this.emit({
          type: "run.failed",
          runId,
          timestamp: Date.now(),
          data: { agent: task.agent, error: error instanceof Error ? error.message : String(error) },
        });
      }
      throw error;
    } finally {
      this.release();
    }
  }

  async runParallel(ai: AIClient, tasks: AgentTask[]): Promise<Array<AgentRunResult & { runId: string }>> {
    return Promise.all(tasks.map((task) => this.run(ai, task)));
  }

  private validateRetry(policy: AgentRetryPolicy): Required<AgentRetryPolicy> {
    const maxAttempts = policy.maxAttempts ?? 1;
    const delayMs = policy.delayMs ?? 100;
    const backoff = policy.backoff ?? 2;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("retry.maxAttempts must be a positive integer");
    if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error("retry.delayMs must be a non-negative integer");
    if (!Number.isFinite(backoff) || backoff < 1) throw new Error("retry.backoff must be at least 1");
    return { maxAttempts, delayMs, backoff };
  }

  private async sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (delayMs === 0) return;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private async emit(event: ExecutionEvent): Promise<void> {
    await this.store?.appendEvent(event.runId, event);
    await this.onEvent?.(event);
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason ?? new Error("Aborted"));
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
    this.active += 1;
  }

  private release(): void {
    while (this.waiters.length) {
      const next = this.waiters.shift()!;
      if (next.signal?.aborted) {
        next.reject(next.signal.reason ?? new Error("Aborted"));
        continue;
      }
      next.resolve();
      return;
    }
    this.active -= 1;
  }
}
