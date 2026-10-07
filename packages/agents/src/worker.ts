import { randomUUID } from "node:crypto";
import { AIError } from "@woho/core";
import type { ExecutionClaim, ExecutionRecord, ExecutionStore } from "./execution-store.js";

export interface AgentExecutionWorkerOptions {
  readonly workerId?: string;
  readonly leaseTtlMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly projectId?: string;
}

export interface AgentExecutionWorkerContext {
  readonly workerId: string;
  readonly signal: AbortSignal;
  readonly attempt: number;
  readonly recovered: boolean;
}

export interface AgentExecutionWorkerOutcome {
  readonly runId: string;
  readonly attempt: number;
  readonly recovered: boolean;
  readonly status: "succeeded" | "failed" | "queued" | "lease_lost";
}

export type AgentExecutionWorkerHandler = (
  record: ExecutionRecord,
  context: AgentExecutionWorkerContext,
) => void | Promise<void>;

export class AgentExecutionWorker {
  private readonly store: ExecutionStore;
  private readonly workerId: string;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly projectId?: string;
  private runOnceInFlight = false;

  constructor(store: ExecutionStore, options: AgentExecutionWorkerOptions = {}) {
    this.store = store;
    this.workerId = options.workerId ?? randomUUID();
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? Math.max(1_000, Math.floor(this.leaseTtlMs / 3));
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 0;
    this.projectId = options.projectId;
    if (!this.store.claimNextExecution || !this.store.renewLease || !this.store.transitionFenced || !this.store.releaseLease) {
      throw new Error("Execution store does not support durable worker claims");
    }
    if (!this.workerId.trim()) throw new Error("workerId is required");
    if (!Number.isInteger(this.leaseTtlMs) || this.leaseTtlMs < 1) throw new Error("leaseTtlMs must be a positive integer");
    if (!Number.isInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1 || this.heartbeatIntervalMs >= this.leaseTtlMs) {
      throw new Error("heartbeatIntervalMs must be positive and less than leaseTtlMs");
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
    if (!Number.isInteger(this.retryDelayMs) || this.retryDelayMs < 0) throw new Error("retryDelayMs must be a non-negative integer");
  }

  async runOnce(handler: AgentExecutionWorkerHandler): Promise<AgentExecutionWorkerOutcome | undefined> {
    if (this.runOnceInFlight) return undefined;
    this.runOnceInFlight = true;
    try {
      const claim = await this.store.claimNextExecution!(this.workerId, this.leaseTtlMs, { projectId: this.projectId });
      if (!claim) return undefined;
      return await this.executeClaim(claim, handler);
    } finally {
      this.runOnceInFlight = false;
    }
  }

  async drain(handler: AgentExecutionWorkerHandler, maxJobs = Number.MAX_SAFE_INTEGER): Promise<AgentExecutionWorkerOutcome[]> {
    if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new Error("maxJobs must be a positive integer");
    const outcomes: AgentExecutionWorkerOutcome[] = [];
    while (outcomes.length < maxJobs) {
      const outcome = await this.runOnce(handler);
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  private async executeClaim(claim: ExecutionClaim, handler: AgentExecutionWorkerHandler): Promise<AgentExecutionWorkerOutcome> {
    const { record, lease } = claim;
    const controller = new AbortController();
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void Promise.resolve(this.store.renewLease!(record.runId, this.workerId, lease.fencingToken, this.leaseTtlMs)).then((renewed) => {
        if (!renewed) {
          leaseLost = true;
          controller.abort(new AIError("Execution worker lease was lost", "EXECUTION_LEASE_LOST"));
        }
      }).catch(() => {
        leaseLost = true;
        controller.abort(new AIError("Execution worker lease renewal failed", "EXECUTION_LEASE_LOST"));
      });
    }, this.heartbeatIntervalMs);

    try {
      await handler(record, {
        workerId: this.workerId,
        signal: controller.signal,
        attempt: record.attempts,
        recovered: claim.recovered,
      });
      if (leaseLost || controller.signal.aborted) return { runId: record.runId, attempt: record.attempts, recovered: claim.recovered, status: "lease_lost" };
      const timestamp = Date.now();
      try {
        await this.store.transitionFenced!(record.runId, lease.fencingToken, {
          status: "succeeded",
          completedAt: timestamp,
          updatedAt: timestamp,
          availableAt: undefined,
        }, {
          type: "run.completed",
          runId: record.runId,
          timestamp,
          data: { eventId: randomUUID(), workerId: this.workerId, attempt: record.attempts },
        });
      } catch (error) {
        const current = this.store.get ? await this.store.get(record.runId) : undefined;
        if (current?.status === "cancelled" || current?.status === "succeeded" || current?.status === "failed" || leaseLost) {
          return { runId: record.runId, attempt: record.attempts, recovered: claim.recovered, status: "lease_lost" };
        }
        throw error;
      }
      return { runId: record.runId, attempt: record.attempts, recovered: claim.recovered, status: "succeeded" };
    } catch (error) {
      if (leaseLost || controller.signal.aborted) {
        return { runId: record.runId, attempt: record.attempts, recovered: claim.recovered, status: "lease_lost" };
      }
      const timestamp = Date.now();
      const message = error instanceof Error ? error.message.slice(0, 4096) : "Worker execution failed";
      if (record.attempts < this.maxAttempts) {
        const availableAt = timestamp + this.retryDelayMs;
        try {
          await this.store.transitionFenced!(record.runId, lease.fencingToken, {
            status: "queued",
            updatedAt: timestamp,
            availableAt,
            error: message,
          }, {
            type: "run.waiting",
            runId: record.runId,
            timestamp,
            data: { eventId: randomUUID(), reason: "worker-retry", attempt: record.attempts, availableAt },
          });
        } catch (transitionError) {
          const current = this.store.get ? await this.store.get(record.runId) : undefined;
          if (current?.status === "cancelled" || current?.status === "succeeded" || current?.status === "failed" || leaseLost) {
            return { runId: record.runId, attempt: record.attempts, recovered: claim.recovered, status: "lease_lost" };
          }
          throw transitionError;
        }
        return { runId: record.runId, attempt: record.attempts, recovered: claim.recovered, status: "queued" };
      }
      try {
        await this.store.transitionFenced!(record.runId, lease.fencingToken, {
          status: "failed",
          updatedAt: timestamp,
          completedAt: timestamp,
          availableAt: undefined,
          error: message,
        }, {
          type: "run.failed",
          runId: record.runId,
          timestamp,
          data: { eventId: randomUUID(), reason: "worker-execution-failed", attempt: record.attempts },
        });
      } catch (transitionError) {
        const current = this.store.get ? await this.store.get(record.runId) : undefined;
        if (current?.status === "cancelled" || current?.status === "succeeded" || current?.status === "failed" || leaseLost) {
          return { runId: record.runId, attempt: record.attempts, recovered: claim.recovered, status: "lease_lost" };
        }
        throw transitionError;
      }
      return { runId: record.runId, attempt: record.attempts, recovered: claim.recovered, status: "failed" };
    } finally {
      clearInterval(heartbeat);
      await Promise.resolve(this.store.releaseLease!(record.runId, this.workerId, lease.fencingToken)).catch(() => false);
    }
  }
}
