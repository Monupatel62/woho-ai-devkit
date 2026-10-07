import { createHash, randomUUID } from "node:crypto";
import { AIError, type AIClient, type ExecutionContext, type ExecutionEvent } from "@woho/core";
import { Agent, type AgentApprovalHandler, type AgentExecutionCheckpoint, type AgentRunResult } from "./index.js";
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
  /** Poll interval used when a run has a durable approval but no in-process approval handler. */
  readonly approvalPollIntervalMs?: number;
  /** Maximum UTF-8 bytes retained in a durable execution checkpoint. Defaults to 512 KiB. */
  readonly maxCheckpointBytes?: number;
  /** Maximum serialized tool receipt size retained for idempotent replay. */
  readonly maxToolReceiptBytes?: number;
  /** Lease duration for stores that support fenced execution ownership. */
  readonly executionLeaseTtlMs?: number;
}

export interface PendingApproval {
  readonly runId: string;
  readonly projectId?: string;
  readonly approvalId: string;
  readonly callId: string;
  readonly tool: string;
  readonly capability: string;
  readonly action: string;
  readonly reason?: string;
  readonly requestedAt: number;
}

export interface AgentResumeOptions {
  readonly retry?: AgentRetryPolicy;
  readonly approval?: AgentApprovalHandler;
  readonly verify?: AgentVerifier;
}

export interface AgentTask {
  readonly agent: string;
  readonly input: string;
  /** Stable project scope carried into durable execution history. */
  readonly projectId?: string;
  readonly parentRunId?: string;
  /** Optional caller-supplied run ID; primarily used for idempotent durable resume. */
  readonly runId?: string;
  readonly sessionId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly retry?: AgentRetryPolicy;
  readonly approval?: AgentApprovalHandler;
  readonly verify?: AgentVerifier;
  /** Optional durable checkpoint used to continue a safe recovery. */
  readonly checkpoint?: AgentExecutionCheckpoint;
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
  private readonly approvalPollIntervalMs: number;
  private readonly maxCheckpointBytes: number;
  private readonly maxToolReceiptBytes: number;
  private readonly executionLeaseTtlMs: number;
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
    this.approvalPollIntervalMs = options.approvalPollIntervalMs ?? 250;
    this.maxCheckpointBytes = options.maxCheckpointBytes ?? 512 * 1024;
    this.maxToolReceiptBytes = options.maxToolReceiptBytes ?? 512 * 1024;
    this.executionLeaseTtlMs = options.executionLeaseTtlMs ?? 30_000;
    if (!Number.isInteger(this.maxToolReceiptBytes) || this.maxToolReceiptBytes < 1) throw new Error("maxToolReceiptBytes must be a positive integer");
    if (!Number.isInteger(this.executionLeaseTtlMs) || this.executionLeaseTtlMs < 1) throw new Error("executionLeaseTtlMs must be a positive integer");
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) throw new Error("maxConcurrency must be a positive integer");
    if (!Number.isInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1) throw new Error("heartbeatIntervalMs must be a positive integer");
    if (!Number.isInteger(this.maxInputBytes) || this.maxInputBytes < 1) throw new Error("maxInputBytes must be a positive integer");
    if (!Number.isInteger(this.maxErrorMessageBytes) || this.maxErrorMessageBytes < 1) throw new Error("maxErrorMessageBytes must be a positive integer");
    if (!Number.isInteger(this.approvalPollIntervalMs) || this.approvalPollIntervalMs < 10) throw new Error("approvalPollIntervalMs must be at least 10ms");
    if (!Number.isInteger(this.maxCheckpointBytes) || this.maxCheckpointBytes < 1024) throw new Error("maxCheckpointBytes must be at least 1024 bytes");
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
    await this.store?.create({ runId, projectId: task.projectId, agent: task.agent, ...(this.persistInput ? { input: task.input } : {}), parentRunId: task.parentRunId, sessionId: task.sessionId, metadata: task.metadata ?? {}, status: "running", startedAt, updatedAt: startedAt, attempts: 0, events: [], ...(task.checkpoint ? { checkpoint: task.checkpoint } : {}) });
    const leaseOwnerId = randomUUID();
    const lease = this.store?.acquireLease ? await this.store.acquireLease(runId, leaseOwnerId, this.executionLeaseTtlMs, startedAt) : undefined;
    if (this.store?.acquireLease && !lease) throw new AIError("Execution is already owned by another worker", "EXECUTION_LEASE_CONFLICT");
    let leaseLost = false;
    await this.emit({ type: "run.started", runId, timestamp: startedAt, data: { agent: task.agent, sessionId: task.sessionId } }, lease);
    const heartbeat = this.store
      ? setInterval(() => {
          void (async () => {
            const now = Date.now();
            if (lease && this.store?.renewLease) {
              const renewed = await this.store.renewLease(runId, leaseOwnerId, lease.fencingToken, this.executionLeaseTtlMs, now);
              if (!renewed) { leaseLost = true; return; }
            }
            await this.updateExecution(runId, { updatedAt: now }, lease);
          })().catch(() => undefined);
        }, this.heartbeatIntervalMs)
      : undefined;

    let latestCheckpoint = task.checkpoint;
    try {
      for (let attempt = 1; attempt <= retry.maxAttempts; attempt += 1) {
        try {
          if (leaseLost) throw new AIError("Execution lease was lost", "EXECUTION_LEASE_LOST");
          if (task.signal?.aborted) throw task.signal.reason ?? new Error("Aborted");
          await this.updateExecution(runId, { attempts: attempt, status: "running", updatedAt: Date.now() }, lease);
          const agent = this.registry.create(task.agent, ai);
          const approvalHandler = task.approval ?? this.approval;
          const auditedApproval = this.persistApprovalAudit && this.store
            ? async (request: Parameters<NonNullable<AgentApprovalHandler>>[0]): Promise<boolean> => {
                const approvalId = randomUUID();
                const requestedAt = Date.now();
                const reason = request.reason ? this.sanitizeError(request.reason) : undefined;
                const approval = {
                  approvalId,
                  callId: request.callId,
                  status: "pending" as const,
                  tool: request.tool,
                  capability: request.capability,
                  action: request.action,
                  ...(reason ? { reason } : {}),
                  requestedAt,
                };
                await this.updateExecution(runId, { approval, status: "waiting", updatedAt: requestedAt }, lease);
                const durableRequest = { ...request, approvalId };
                try {
                  const approved = approvalHandler
                    ? await approvalHandler(durableRequest)
                    : await this.waitForApproval(runId, approvalId, task.signal);
                  const decidedAt = Date.now();
                  await this.updateExecution(runId, {
                    approval: { ...approval, status: approved ? "approved" : "denied", decidedAt },
                    status: "running",
                    updatedAt: decidedAt,
                  }, lease);
                  return approved;
                } catch (approvalError) {
                  const decidedAt = Date.now();
                  await Promise.resolve().then(() => this.updateExecution(runId, {
                    approval: { ...approval, status: "denied", decidedAt },
                    status: "running",
                    updatedAt: decidedAt,
                  }, lease)).catch(() => undefined);
                  throw approvalError;
                }
              }
            : approvalHandler;
          const result = await agent.run(task.input, {
            signal: context.signal,
            runId,
            onEvent: async (event) => {
              await this.recordAgentEvent(event, lease);
            },
            approval: auditedApproval,
            checkpoint: latestCheckpoint,
            onBeforeToolExecution: this.store?.claimToolExecutionFenced && lease ? async ({ callId, tool, input }) => {
              const fingerprint = createHash("sha256").update(tool).update("\0").update(JSON.stringify(input)).digest("hex");
              const receipt = await this.store!.claimToolExecutionFenced!(runId, lease!.fencingToken, callId, fingerprint);
              if (!receipt) return;
              if (receipt.status === "in_flight") throw new AIError("Tool side effect is already in flight and cannot be replayed safely: " + callId, "TOOL_SIDE_EFFECT_AMBIGUOUS");
              if (receipt.fingerprint !== fingerprint) throw new AIError("Tool execution fingerprint conflict: " + callId, "TOOL_IDEMPOTENCY_CONFLICT");
              if (receipt.status === "failed") return { replay: true, result: { error: receipt.error ?? "TOOL_EXECUTION_ERROR" } };
              if (receipt.result === undefined) throw new AIError("Completed tool receipt has no result: " + callId, "TOOL_RECEIPT_INVALID");
              let replayResult: unknown;
              try { replayResult = receipt.result === "__WOHO_UNDEFINED_RESULT__" ? undefined : JSON.parse(receipt.result); } catch { throw new AIError("Completed tool receipt is not valid JSON: " + callId, "TOOL_RECEIPT_INVALID"); }
              return { replay: true, result: replayResult };
            } : undefined,
            onToolExecutionComplete: this.store?.completeToolExecutionFenced && lease ? async ({ callId, tool, input, result, error }) => {
              const fingerprint = createHash("sha256").update(tool).update("\0").update(JSON.stringify(input)).digest("hex");
              const payload = result === undefined ? "__WOHO_UNDEFINED_RESULT__" : JSON.stringify(result);
              if (payload === undefined) throw new AIError("Tool result is not serializable for durable receipt", "TOOL_RECEIPT_INVALID");
              if (Buffer.byteLength(payload, "utf8") > this.maxToolReceiptBytes) throw new AIError("Tool receipt exceeds maxToolReceiptBytes", "TOOL_RECEIPT_TOO_LARGE");
              const completed = await this.store!.completeToolExecutionFenced!(runId, lease!.fencingToken, callId, fingerprint, error ? { status: "failed", error } : { status: "completed", result: payload });
              if (!completed) throw new AIError("Tool receipt could not be committed safely: " + callId, "TOOL_RECEIPT_COMMIT_FAILED");
            } : undefined,
            onCheckpoint: this.store ? async (checkpoint: AgentExecutionCheckpoint) => {
              const sanitizedCheckpoint = this.sanitizeCheckpoint(checkpoint);
              latestCheckpoint = sanitizedCheckpoint;
              let serialized: string;
              try {
                serialized = JSON.stringify(sanitizedCheckpoint);
              } catch {
                throw new AIError("Execution checkpoint is not serializable", "CHECKPOINT_INVALID");
              }
              if (Buffer.byteLength(serialized, "utf8") > this.maxCheckpointBytes) {
                throw new AIError("Execution checkpoint exceeds maxCheckpointBytes", "CHECKPOINT_TOO_LARGE");
              }
              await this.updateExecution(runId, {
                checkpoint: sanitizedCheckpoint,
                updatedAt: sanitizedCheckpoint.updatedAt,
              }, lease);
            } : undefined,
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
            await this.transitionExecution(runId, lease, { status: "succeeded", attempts: attempt, usage: result.usage, completedAt }, completedEvent);
            await this.onEvent?.(completedEvent);
          } else {
            await this.store?.update(runId, { status: "succeeded", attempts: attempt, usage: result.usage, completedAt, updatedAt: completedAt });
            await this.emit(completedEvent, lease);
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
            await this.transitionExecution(runId, lease, { status: "waiting", attempts: attempt }, waitingEvent);
            await this.onEvent?.(waitingEvent);
          } else {
            await this.store?.update(runId, { status: "waiting", attempts: attempt, updatedAt: waitingAt });
            await this.emit(waitingEvent, lease);
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
          await this.transitionExecution(runId, lease, { status: "cancelled", completedAt: cancelledAt }, cancelledEvent);
          await this.onEvent?.(cancelledEvent);
        } else {
          await this.store?.update(runId, { status: "cancelled", completedAt: cancelledAt, updatedAt: cancelledAt });
          await this.emit(cancelledEvent, lease);
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
          await this.transitionExecution(runId, lease, { status: "failed", completedAt: failedAt, error: failureMessage }, failedEvent);
          await this.onEvent?.(failedEvent);
        } else {
          await this.store?.update(runId, { status: "failed", completedAt: failedAt, updatedAt: failedAt, error: failureMessage });
          await this.emit(failedEvent, lease);
        }
      }
      throw error;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (lease && this.store?.releaseLease) {
        try {
          await this.store.releaseLease(runId, leaseOwnerId, lease.fencingToken);
        } catch {
          // Lease cleanup is best-effort after the execution has already reached a terminal boundary.
        }
      }
      this.release();
    }
  }

  private async recordAgentEvent(event: ExecutionEvent, lease?: { fencingToken: number }): Promise<void> {
    if (this.store && lease) {
      if (!this.store.transitionFenced) throw new AIError("Execution store does not support fenced mutation", "EXECUTION_FENCING_UNSUPPORTED");
      await this.store.transitionFenced(event.runId, lease.fencingToken, {}, event);
    } else if (this.store?.transition) {
      await this.store.transition(event.runId, {}, event);
    } else if (this.store?.appendEvent) {
      await this.store.appendEvent(event.runId, event);
    }
    await this.onEvent?.(event);
  }

  /** Return durable approvals that are still waiting for an owner decision. */
  async listPendingApprovals(options: { projectId?: string; limit?: number } = {}): Promise<PendingApproval[]> {
    if (!this.store) throw new Error("Execution store is required for approval recovery");
    const records = await this.store.list({ status: "waiting", projectId: options.projectId, limit: options.limit });
    return records
      .filter((record) => record.approval?.status === "pending")
      .map((record) => ({
        runId: record.runId,
        ...(record.projectId ? { projectId: record.projectId } : {}),
        approvalId: record.approval!.approvalId,
        callId: record.approval!.callId,
        tool: record.approval!.tool,
        capability: record.approval!.capability,
        action: record.approval!.action,
        ...(record.approval!.reason ? { reason: record.approval!.reason } : {}),
        requestedAt: record.approval!.requestedAt,
      }));
  }

  /** Atomically resolve one exact durable approval request. */
  async resolveApproval(runId: string, approvalId: string, approved: boolean, reason?: string): Promise<boolean> {
    if (!this.store?.resolveApproval) throw new Error("Execution store does not support durable approval resolution");
    if (typeof approved !== "boolean") throw new Error("Approval decision must be boolean");
    const sanitizedReason = reason ? this.sanitizeError(reason) : undefined;
    return this.store.resolveApproval(runId, approvalId, approved, sanitizedReason);
  }

  private async waitForApproval(runId: string, approvalId: string, signal?: AbortSignal): Promise<boolean> {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("Approval wait aborted");
      const record = await this.store?.get(runId);
      const approval = record?.approval;
      if (!approval || approval.approvalId !== approvalId) throw new AIError("Durable approval request disappeared", "APPROVAL_STATE_LOST");
      if (approval.status === "approved") return true;
      if (approval.status === "denied") return false;
      await this.sleep(this.approvalPollIntervalMs, signal);
    }
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
    if (record.checkpoint?.inFlightToolCallId) {
      throw new AIError(
        "Execution checkpoint contains an in-flight tool call and cannot be resumed automatically: " + record.checkpoint.inFlightToolCallId,
        "CHECKPOINT_SIDE_EFFECT_AMBIGUOUS",
      );
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
      projectId: record.projectId,
      sessionId: record.sessionId,
      metadata: { ...record.metadata },
      retry: options.retry,
      approval: options.approval,
      verify: options.verify,
      checkpoint: record.checkpoint
        ? {
            step: record.checkpoint.step,
            messages: record.checkpoint.messages,
            updatedAt: record.checkpoint.updatedAt,
          }
        : undefined,
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

  private async updateExecution(runId: string, patch: Partial<ExecutionRecord>, lease?: { fencingToken: number }): Promise<void> {
    if (!this.store) return;
    if (lease) {
      if (!this.store.updateFenced) throw new AIError("Execution store does not support fenced mutation", "EXECUTION_FENCING_UNSUPPORTED");
      await this.store.updateFenced(runId, lease.fencingToken, patch);
    } else {
      await this.store.update(runId, patch);
    }
  }

  private async transitionExecution(runId: string, lease: { fencingToken: number } | undefined, patch: Partial<ExecutionRecord>, event: ExecutionEvent, expectedUpdatedAt?: number): Promise<void> {
    if (!this.store) return;
    if (lease) {
      if (!this.store.transitionFenced) throw new AIError("Execution store does not support fenced mutation", "EXECUTION_FENCING_UNSUPPORTED");
      await this.store.transitionFenced(runId, lease.fencingToken, patch, event, expectedUpdatedAt);
      await this.onEvent?.(event);
      return;
    }
    if (this.store.transition) await this.store.transition(runId, patch, event, expectedUpdatedAt);
    else { await this.store.update(runId, patch); await this.store.appendEvent?.(runId, event); }
    await this.onEvent?.(event);
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

  private sanitizeCheckpoint(checkpoint: AgentExecutionCheckpoint): AgentExecutionCheckpoint {
    const sanitizeText = (value: string): string => this.sanitizeError(value);
    const messages = checkpoint.messages.map((message) => ({
      ...message,
      ...(typeof message.content === "string" ? { content: sanitizeText(message.content) } : {}),
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              ...call,
              arguments: sanitizeText(call.arguments),
            })),
          }
        : {}),
    }));
    return {
      ...checkpoint,
      messages,
      ...(checkpoint.inFlightToolCallId ? { inFlightToolCallId: sanitizeText(checkpoint.inFlightToolCallId) } : {}),
    };
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

  private async emit(event: ExecutionEvent, lease?: { fencingToken: number }): Promise<void> {
    if (this.store && lease) {
      if (!this.store.transitionFenced) throw new AIError("Execution store does not support fenced mutation", "EXECUTION_FENCING_UNSUPPORTED");
      await this.store.transitionFenced(event.runId, lease.fencingToken, {}, event);
    } else if (this.store.transition) {
      await this.store.transition(event.runId, {}, event);
    } else {
      await this.store.appendEvent?.(event.runId, event);
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
