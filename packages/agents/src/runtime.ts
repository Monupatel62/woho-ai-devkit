import { randomUUID } from "node:crypto";
import { AIError, type AIClient, type ExecutionContext, type ExecutionEvent } from "@woho/core";
import { Agent, type AgentApprovalHandler, type AgentRunResult } from "./index.js";
import { AgentRegistry, type AgentDefinition } from "./definition.js";
import {
  recoverStaleExecutions,
  pruneExecutionHistory,
  type ExecutionStore,
  type PruneExecutionHistoryOptions,
  type RecoverStaleExecutionsOptions,
  type ExecutionRecord,
} from "./execution-store.js";

export interface AgentRetryPolicy {
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly backoff?: number;
}

export type AgentVerifier = (result: AgentRunResult, task: AgentTask) => boolean | string | Promise<boolean | string>;

export interface AgentRuntimeOptions {
  readonly maxConcurrency?: number;
  readonly onEvent?: (event: ExecutionEvent) => void | Promise<void>;
  readonly retry?: AgentRetryPolicy;
  readonly approval?: AgentApprovalHandler;
  readonly store?: ExecutionStore;
  readonly verify?: AgentVerifier;
  /** Persist a heartbeat while an execution is actively running. */
  readonly heartbeatIntervalMs?: number;
  /** Persist task input in execution history so failed runs can be resumed. Defaults to true. */
  readonly persistInput?: boolean;
  /** Maximum UTF-8 byte length of task input accepted by the runtime. Defaults to 1 MiB. */
  readonly maxInputBytes?: number;
  /** Maximum UTF-8 byte length of persisted lifecycle error messages. Defaults to 4 KiB. */
  readonly maxErrorMessageBytes?: number;
  /** Persist approval request/decision state for durable audit. */
  readonly persistApprovalAudit?: boolean;
}

export interface AgentResumeOptions {
  readonly retry?: AgentRetryPolicy;
  readonly approval?: AgentApprovalHandler;
  readonly verify?: AgentVerifier;
}

export interface AgentTask {
  readonly agent: string;
  readonly input: string;
  readonly parentRunId?: string;
  /** Optional caller-supplied run ID; primarily used for idempotent durable resume. */
  readonly runId?: string;
  readonly sessionId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly retry?: AgentRetryPolicy;
  readonly approval?: AgentApprovalHandler;
  readonly verify?: AgentVerifier;
}

export class AgentRuntime {
  readonly registry: AgentRegistry;
  private readonly maxConcurrency: number;
  private readonly onEvent?: AgentRuntimeOptions["onEvent"];
  private readonly defaultRetry: Required<AgentRetryPolicy>;
  private readonly store?: ExecutionStore;
  private readonly approval?: AgentApprovalHandler;
  private readonly verify?: AgentVerifier;
  private readonly heartbeatIntervalMs: number;
  private readonly persistInput: boolean;
  private readonly maxInputBytes: number;
  private readonly maxErrorMessageBytes: number;
  private readonly persistApprovalAudit: boolean;
  private active = 0;
  private readonly waiters: Array<{ resolve: () => void; reject: (error: unknown) => void; signal?: AbortSignal }> = [];

  constructor(options: AgentRuntimeOptions = {}, registry = new AgentRegistry()) {
    this.registry = registry;
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.onEvent = options.onEvent;
    this.defaultRetry = this.validateRetry(options.retry ?? {});
    this.store = options.store;
    this.approval = options.approval;
    this.verify = options.verify;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.persistInput = options.persistInput ?? true;
    this.maxInputBytes = options.maxInputBytes ?? 1_048_576;
    this.maxErrorMessageBytes = options.maxErrorMessageBytes ?? 4 * 1024;
    this.persistApprovalAudit = options.persistApprovalAudit ?? true;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) throw new Error("maxConcurrency must be a positive integer");
    if (!Number.isInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1) throw new Error("heartbeatIntervalMs must be a positive integer");
    if (!Number.isInteger(this.maxInputBytes) || this.maxInputBytes < 1) throw new Error("maxInputBytes must be a positive integer");
    if (!Number.isInteger(this.maxErrorMessageBytes) || this.maxErrorMessageBytes < 1) throw new Error("maxErrorMessageBytes must be a positive integer");
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
    const runId = task.runId ?? randomUUID();
    this.validateInput(task.input);
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
    await this.store?.create({ runId, agent: task.agent, ...(this.persistInput ? { input: task.input } : {}), parentRunId: task.parentRunId, sessionId: task.sessionId, metadata: task.metadata ?? {}, status: "running", startedAt, updatedAt: startedAt, attempts: 0, events: [] });
    await this.emit({ type: "run.started", runId, timestamp: startedAt, data: { agent: task.agent, sessionId: task.sessionId } });
    const heartbeat = this.store
      ? setInterval(() => {
          void Promise.resolve(this.store?.update(runId, { updatedAt: Date.now() })).catch(() => undefined);
        }, this.heartbeatIntervalMs)
      : undefined;

    try {
      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        try {
          if (task.signal?.aborted) throw task.signal.reason ?? new Error("Aborted");
          await this.store?.update(runId, { attempts: attempt, status: "running", updatedAt: Date.now() });
          const agent = this.registry.create(task.agent, ai);
          const approvalHandler = task.approval ?? this.approval;
          const auditedApproval = approvalHandler && this.persistApprovalAudit && this.store
            ? async (request: Parameters<NonNullable<typeof approvalHandler>>[0]): Promise<boolean> => {
                const requestedAt = Date.now();
                const reason = request.reason ? this.sanitizeError(request.reason) : undefined;
                await this.store?.update(runId, {
                  approval: {
                    status: "pending",
                    tool: request.tool,
                    capability: request.capability,
                    action: request.action,
                    ...(reason ? { reason } : {}),
                    requestedAt,
                  },
                  updatedAt: requestedAt,
                });
                try {
                  const approved = await approvalHandler(request);
                  const decidedAt = Date.now();
                  await this.store?.update(runId, {
                    approval: {
                      status: approved ? "approved" : "denied",
                      tool: request.tool,
                      capability: request.capability,
                      action: request.action,
                      ...(reason ? { reason } : {}),
                      requestedAt,
                      decidedAt,
                    },
                    updatedAt: decidedAt,
                  });
                  return approved;
                } catch (approvalError) {
                  const decidedAt = Date.now();
                  await this.store?.update(runId, {
                    approval: {
                      status: "denied",
                      tool: request.tool,
                      capability: request.capability,
                      action: request.action,
                      ...(reason ? { reason } : {}),
                      requestedAt,
                      decidedAt,
                    },
                    updatedAt: decidedAt,
                  });
                  throw approvalError;
                }
              }
            : approvalHandler;
          const result = await agent.run(task.input, {
            signal: context.signal,
            runId,
            onEvent: async (event) => {
              await this.recordAgentEvent(event);
            },
            approval: auditedApproval,
          });
          const verification = task.verify ?? this.verify;
          if (verification) {
            const verdict = await verification(result, task);
            if (verdict !== true) {
              throw new AIError(typeof verdict === "string" ? verdict : "Agent result verification failed", "VERIFICATION_FAILED");
            }
          }
          const completedAt = Date.now();
          const completedEvent: ExecutionEvent = {
            type: "run.completed",
            runId,
            timestamp: completedAt,
            data: { agent: task.agent, steps: result.steps, attempts: attempt, verified: Boolean(verification) },
          };
          if (this.store?.transition) {
            await this.store.transition(runId, { status: "succeeded", attempts: attempt, usage: result.usage, completedAt }, completedEvent);
            await this.onEvent?.(completedEvent);
          } else {
            await this.store?.update(runId, { status: "succeeded", attempts: attempt, usage: result.usage, completedAt, updatedAt: completedAt });
            await this.emit(completedEvent);
          }
          return { ...result, runId };
        } catch (error) {
          if (task.signal?.aborted) throw error;
          if (attempt >= retry.maxAttempts) throw error;
          const delay = retry.delayMs * Math.pow(retry.backoff, attempt - 1);
          const waitingAt = Date.now();
          const waitingEvent: ExecutionEvent = {
            type: "run.waiting",
            runId,
            timestamp: waitingAt,
            data: { agent: task.agent, attempt, nextAttempt: attempt + 1, delayMs: delay },
          };
          if (this.store?.transition) {
            await this.store.transition(runId, { status: "waiting", attempts: attempt }, waitingEvent);
            await this.onEvent?.(waitingEvent);
          } else {
            await this.store?.update(runId, { status: "waiting", attempts: attempt, updatedAt: waitingAt });
            await this.emit(waitingEvent);
          }
          await this.sleep(delay, task.signal);
        }
      }
      throw new Error("Agent runtime exhausted retry loop");
    } catch (error) {
      if (task.signal?.aborted) {
        const cancelledAt = Date.now();
        const cancelledEvent: ExecutionEvent = { type: "run.cancelled", runId, timestamp: cancelledAt, data: { agent: task.agent } };
        if (this.store?.transition) {
          await this.store.transition(runId, { status: "cancelled", completedAt: cancelledAt }, cancelledEvent);
          await this.onEvent?.(cancelledEvent);
        } else {
          await this.store?.update(runId, { status: "cancelled", completedAt: cancelledAt, updatedAt: cancelledAt });
          await this.emit(cancelledEvent);
        }
      } else {
        const failedAt = Date.now();
        const failureMessage = this.sanitizeError(error);
        const failedEvent: ExecutionEvent = {
          type: "run.failed",
          runId,
          timestamp: failedAt,
          data: { agent: task.agent, error: failureMessage },
        };
        if (this.store?.transition) {
          await this.store.transition(runId, { status: "failed", completedAt: failedAt, error: failureMessage }, failedEvent);
          await this.onEvent?.(failedEvent);
        } else {
          await this.store?.update(runId, { status: "failed", completedAt: failedAt, updatedAt: failedAt, error: failureMessage });
          await this.emit(failedEvent);
        }
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.release();
    }
  }

  private async recordAgentEvent(event: ExecutionEvent): Promise<void> {
    if (this.store?.transition) {
      await this.store.transition(event.runId, {}, event, undefined);
    } else {
      await this.store?.appendEvent(event.runId, event);
      await this.store?.update(event.runId, { updatedAt: event.timestamp });
    }
    await this.onEvent?.(event);
  }

  /** Restart a persisted failed/cancelled execution as a new run linked to the original. */
  async resume(ai: AIClient, runId: string, options: AgentResumeOptions = {}): Promise<AgentRunResult & { runId: string }> {
    if (!this.store) throw new Error("Execution store is required for execution resume");
    const record = await this.store.get(runId);
    if (!record) throw new Error("Execution not found: " + runId);
    if (record.status !== "failed" && record.status !== "cancelled") {
      throw new Error("Only failed or cancelled executions can be resumed: " + runId);
    }
    if (record.input === undefined) {
      throw new Error("Execution record does not contain input and cannot be resumed: " + runId);
    }
    if (record.resumeRunId) {
      throw new Error("Execution resume is already claimed: " + runId);
    }
    const resumeRunId = randomUUID();
    const claimedRunId = this.store.claimResume
      ? await this.store.claimResume(runId, record.updatedAt, resumeRunId)
      : await this.claimResumeFallback(runId, record.updatedAt, resumeRunId);
    if (!claimedRunId) {
      throw new Error("Execution resume was claimed concurrently: " + runId);
    }
    return this.run(ai, {
      runId: claimedRunId,
      agent: record.agent,
      input: record.input,
      parentRunId: record.runId,
      sessionId: record.sessionId,
      metadata: { ...record.metadata },
      retry: options.retry,
      approval: options.approval,
      verify: options.verify,
    });
  }

  private async claimResumeFallback(runId: string, expectedUpdatedAt: number, resumeRunId: string): Promise<string | undefined> {
    const claimed = await this.store?.updateIf?.(runId, expectedUpdatedAt, { resumeRunId });
    return claimed ? resumeRunId : undefined;
  }

  async runParallel(ai: AIClient, tasks: AgentTask[]): Promise<Array<AgentRunResult & { runId: string }>> {
    return Promise.all(tasks.map((task) => this.run(ai, task)));
  }

  /**
   * Mark executions that stopped advancing as failed after a process crash.
   */
  async recoverStale(options: RecoverStaleExecutionsOptions): Promise<ExecutionRecord[]> {
    if (!this.store) throw new Error("Execution store is required for stale-run recovery");
    return recoverStaleExecutions(this.store, options);
  }

  /**
   * Apply explicit execution-history retention. No automatic deletion occurs.
   */
  async pruneHistory(options: PruneExecutionHistoryOptions): Promise<ExecutionRecord[]> {
    if (!this.store) throw new Error("Execution store is required for history pruning");
    return pruneExecutionHistory(this.store, options);
  }

  private sanitizeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const redacted = raw
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
      .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]")
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_TOKEN]")
      .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, "[REDACTED_TOKEN]")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]");
    if (Buffer.byteLength(redacted, "utf8") <= this.maxErrorMessageBytes) return redacted;
    const suffix = "…[truncated]";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    if (suffixBytes >= this.maxErrorMessageBytes) {
      return Buffer.from(suffix, "utf8").subarray(0, this.maxErrorMessageBytes).toString("utf8");
    }
    let low = 0;
    let high = redacted.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = redacted.slice(0, mid);
      if (Buffer.byteLength(candidate, "utf8") + suffixBytes <= this.maxErrorMessageBytes) low = mid;
      else high = mid - 1;
    }
    return redacted.slice(0, low) + suffix;
  }

  private validateInput(input: string): void {
    if (typeof input !== "string") throw new Error("Agent input must be a string");
    if (Buffer.byteLength(input, "utf8") > this.maxInputBytes) {
      throw new Error("Agent input exceeds maxInputBytes");
    }
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
    if (this.store?.transition) {
      await this.store.transition(event.runId, {}, event, undefined);
    } else {
      await this.store?.appendEvent(event.runId, event);
    }
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
      let settled = false;
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const grant = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        fail(signal?.reason ?? new Error("Aborted"));
      };
      waiter.resolve = grant;
      waiter.reject = fail;
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
