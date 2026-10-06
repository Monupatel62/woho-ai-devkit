import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExecutionEvent, ExecutionStatus } from "@woho/core";

export interface ExecutionRecord {
  readonly runId: string;
  readonly agent: string;
  /** Original task input; optional for backward compatibility with older records. */
  readonly input?: string;
  /** Child run ID atomically claimed for a durable resume, when one has been started. */
  readonly resumeRunId?: string;
  readonly parentRunId?: string;
  readonly sessionId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  status: ExecutionStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  attempts: number;
  usage?: import("@woho/core").AIUsage;
  error?: string;
  events: ExecutionEvent[];
}

export interface ExecutionStore {
  create(record: ExecutionRecord): void | Promise<void>;
  update(runId: string, patch: Partial<ExecutionRecord>): void | Promise<void>;
  appendEvent(runId: string, event: ExecutionEvent): void | Promise<void>;
  get(runId: string): ExecutionRecord | undefined | Promise<ExecutionRecord | undefined>;
  list(options?: { status?: ExecutionStatus; limit?: number }): ExecutionRecord[] | Promise<ExecutionRecord[]>;
  remove?(runId: string): boolean | Promise<boolean>;
  updateIf?(runId: string, expectedUpdatedAt: number, patch: Partial<ExecutionRecord>): boolean | Promise<boolean>;
  /** Atomically claim a single child run for resuming a failed/cancelled execution. */
  claimResume?(runId: string, expectedUpdatedAt: number, resumeRunId: string): string | undefined | Promise<string | undefined>;
  /** Atomically apply a record patch and append its lifecycle event. */
  transition?(runId: string, patch: Partial<ExecutionRecord>, event: ExecutionEvent, expectedUpdatedAt?: number): void | Promise<void>;
}

export interface RecoverStaleExecutionsOptions {
  readonly staleAfterMs: number;
  readonly now?: number;
  readonly statuses?: readonly ExecutionStatus[];
}

export interface PruneExecutionHistoryOptions {
  readonly olderThanMs?: number;
  readonly maxRecords?: number;
  readonly now?: number;
  readonly status?: ExecutionStatus;
}

function validateTimestamp(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(name + " must be a non-negative finite number");
}

function validatePositiveDuration(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(name + " must be a positive integer");
}

function validatePruneOptions(options: PruneExecutionHistoryOptions): void {
  if (options.olderThanMs === undefined && options.maxRecords === undefined) throw new Error("Execution prune requires olderThanMs or maxRecords");
  if (options.olderThanMs !== undefined) validatePositiveDuration(options.olderThanMs, "olderThanMs");
  if (options.maxRecords !== undefined && (!Number.isInteger(options.maxRecords) || options.maxRecords < 0)) throw new Error("maxRecords must be a non-negative integer");
  validateTimestamp(options.now, "now");
}

function validateRecoveryOptions(options: RecoverStaleExecutionsOptions): void {
  validatePositiveDuration(options.staleAfterMs, "staleAfterMs");
  validateTimestamp(options.now, "now");
}

function cloneRecord(record: ExecutionRecord): ExecutionRecord {
  return { ...record, metadata: { ...record.metadata }, events: [...record.events] };
}

function validateRunId(runId: string): void {
  if (!runId.trim()) throw new Error("Execution runId is required");
  if (runId.length > 200) throw new Error("Execution runId is too long");
}

const EXECUTION_TRANSITIONS: Readonly<Record<ExecutionStatus, readonly ExecutionStatus[]>> = {
  queued: ["queued", "running", "cancelled", "failed"],
  running: ["running", "waiting", "succeeded", "failed", "cancelled"],
  waiting: ["waiting", "running", "succeeded", "failed", "cancelled"],
  succeeded: ["succeeded"],
  failed: ["failed"],
  cancelled: ["cancelled"],
};

export function isValidExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from]?.includes(to) ?? false;
}

function validateExecutionTransition(current: ExecutionRecord, next: ExecutionStatus | undefined): void {
  if (next === undefined || next === current.status) return;
  if (!isValidExecutionTransition(current.status, next)) {
    throw new Error("Invalid execution status transition: " + current.status + " -> " + next);
  }
}

function validateLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new Error("Execution list limit must be a non-negative integer");
  }
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly records = new Map<string, ExecutionRecord>();

  create(record: ExecutionRecord): void {
    validateRunId(record.runId);
    if (this.records.has(record.runId)) throw new Error("Execution already exists: " + record.runId);
    this.records.set(record.runId, cloneRecord(record));
  }

  update(runId: string, patch: Partial<ExecutionRecord>): void {
    validateRunId(runId);
    const current = this.records.get(runId);
    if (!current) throw new Error("Execution not found: " + runId);
    validateExecutionTransition(current, patch.status);
    this.records.set(runId, cloneRecord({ ...current, ...patch, events: patch.events ? [...patch.events] : current.events }));
  }

  appendEvent(runId: string, event: ExecutionEvent): void {
    validateRunId(runId);
    const current = this.records.get(runId);
    if (!current) return;
    this.records.set(runId, { ...current, updatedAt: event.timestamp, events: [...current.events, event] });
  }

  transition(runId: string, patch: Partial<ExecutionRecord>, event: ExecutionEvent, expectedUpdatedAt?: number): void {
    validateRunId(runId);
    const current = this.records.get(runId);
    if (!current) throw new Error("Execution not found: " + runId);
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) throw new Error("Execution changed before transition: " + runId);
    validateExecutionTransition(current, patch.status);
    this.records.set(runId, cloneRecord({
      ...current,
      ...patch,
      updatedAt: event.timestamp,
      events: [...current.events, event],
    }));
  }

  get(runId: string): ExecutionRecord | undefined {
    validateRunId(runId);
    const record = this.records.get(runId);
    return record ? cloneRecord(record) : undefined;
  }

  list(options: { status?: ExecutionStatus; limit?: number } = {}): ExecutionRecord[] {
    validateLimit(options.limit);
    const records = [...this.records.values()]
      .filter((record) => options.status === undefined || record.status === options.status)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return records.slice(0, options.limit ?? records.length).map(cloneRecord);
  }

  remove(runId: string): boolean {
    validateRunId(runId);
    return this.records.delete(runId);
  }

  updateIf(runId: string, expectedUpdatedAt: number, patch: Partial<ExecutionRecord>): boolean {
    validateRunId(runId);
    const current = this.records.get(runId);
    if (!current || current.updatedAt !== expectedUpdatedAt) return false;
    try { validateExecutionTransition(current, patch.status); } catch { return false; }
    this.records.set(runId, cloneRecord({ ...current, ...patch, events: patch.events ? [...patch.events] : current.events }));
    return true;
  }

  claimResume(runId: string, expectedUpdatedAt: number, resumeRunId: string): string | undefined {
    validateRunId(runId);
    validateRunId(resumeRunId);
    const current = this.records.get(runId);
    if (!current || (current.status !== "failed" && current.status !== "cancelled")) return undefined;
    if (current.resumeRunId) return current.resumeRunId;
    if (current.updatedAt !== expectedUpdatedAt) return undefined;
    this.records.set(runId, cloneRecord({ ...current, resumeRunId, updatedAt: Date.now() }));
    return resumeRunId;
  }
}

export interface FileExecutionStoreOptions {
  readonly directory: string;
  readonly maxRecordBytes?: number;
}

export class FileExecutionStore implements ExecutionStore {
  private readonly directory: string;
  private readonly maxRecordBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: FileExecutionStoreOptions) {
    if (!options.directory.trim()) throw new Error("Execution store directory is required");
    this.directory = path.resolve(options.directory);
    this.maxRecordBytes = options.maxRecordBytes ?? 5_000_000;
    if (!Number.isInteger(this.maxRecordBytes) || this.maxRecordBytes < 1) {
      throw new Error("maxRecordBytes must be a positive integer");
    }
  }

  async create(record: ExecutionRecord): Promise<void> {
    validateRunId(record.runId);
    await this.enqueue(async () => {
      await this.ensureDirectory();
      const target = this.filePath(record.runId);
      try {
        await fs.access(target);
        throw new Error("Execution already exists: " + record.runId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.writeRecord(target, cloneRecord(record), false);
    });
  }

  async update(runId: string, patch: Partial<ExecutionRecord>): Promise<void> {
    validateRunId(runId);
    await this.enqueue(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current) throw new Error("Execution not found: " + runId);
      validateExecutionTransition(current, patch.status);
      await this.writeRecord(target, cloneRecord({ ...current, ...patch, events: patch.events ? [...patch.events] : current.events }), true);
    });
  }

  async appendEvent(runId: string, event: ExecutionEvent): Promise<void> {
    validateRunId(runId);
    await this.enqueue(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current) return;
      await this.writeRecord(target, { ...current, updatedAt: event.timestamp, events: [...current.events, event] }, true);
    });
  }

  async transition(runId: string, patch: Partial<ExecutionRecord>, event: ExecutionEvent, expectedUpdatedAt?: number): Promise<void> {
    validateRunId(runId);
    await this.enqueue(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current) throw new Error("Execution not found: " + runId);
      if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) throw new Error("Execution changed before transition: " + runId);
      validateExecutionTransition(current, patch.status);
      await this.writeRecord(target, {
        ...current,
        ...patch,
        updatedAt: event.timestamp,
        events: [...current.events, event],
      }, true);
    });
  }

  async get(runId: string): Promise<ExecutionRecord | undefined> {
    validateRunId(runId);
    return this.readRecord(this.filePath(runId));
  }

  async list(options: { status?: ExecutionStatus; limit?: number } = {}): Promise<ExecutionRecord[]> {
    validateLimit(options.limit);
    await this.ensureDirectory();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const records: ExecutionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await this.readRecord(path.join(this.directory, entry.name));
      if (!record) continue;
      if (options.status !== undefined && record.status !== options.status) continue;
      records.push(record);
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    return records.slice(0, options.limit ?? records.length).map(cloneRecord);
  }

  async remove(runId: string): Promise<boolean> {
    validateRunId(runId);
    return this.enqueue(async () => {
      try {
        await fs.unlink(this.filePath(runId));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    });
  }

  async updateIf(runId: string, expectedUpdatedAt: number, patch: Partial<ExecutionRecord>): Promise<boolean> {
    validateRunId(runId);
    return this.enqueue(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current || current.updatedAt !== expectedUpdatedAt) return false;
      try { validateExecutionTransition(current, patch.status); } catch { return false; }
      await this.writeRecord(target, cloneRecord({ ...current, ...patch, events: patch.events ? [...patch.events] : current.events }), true);
      return true;
    });
  }

  async claimResume(runId: string, expectedUpdatedAt: number, resumeRunId: string): Promise<string | undefined> {
    validateRunId(runId);
    validateRunId(resumeRunId);
    return this.enqueue(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current || (current.status !== "failed" && current.status !== "cancelled")) return undefined;
      if (current.resumeRunId) return current.resumeRunId;
      if (current.updatedAt !== expectedUpdatedAt) return undefined;
      await this.writeRecord(target, cloneRecord({ ...current, resumeRunId, updatedAt: Date.now() }), true);
      return resumeRunId;
    });
  }

  private filePath(runId: string): string {
    return path.join(this.directory, Buffer.from(runId, "utf8").toString("base64url") + ".json");
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private async readRecord(file: string): Promise<ExecutionRecord | undefined> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > this.maxRecordBytes) {
        throw new Error("Execution record is missing, not a regular file, or too large");
      }
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as ExecutionRecord;
      validateRunId(parsed.runId);
      if (!Array.isArray(parsed.events) || typeof parsed.status !== "string") throw new Error("Invalid execution record");
      return cloneRecord(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeRecord(target: string, record: ExecutionRecord, replace: boolean): Promise<void> {
    const payload = JSON.stringify(record);
    if (Buffer.byteLength(payload, "utf8") > this.maxRecordBytes) throw new Error("Execution record exceeds maxRecordBytes");
    await this.ensureDirectory();
    const temp = path.join(this.directory, "." + path.basename(target) + "." + randomUUID() + ".tmp");
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temp, target);
    } catch (error) {
      if (!replace || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fs.rm(target, { force: true });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}


export async function recoverStaleExecutions(
  store: ExecutionStore,
  options: RecoverStaleExecutionsOptions,
): Promise<ExecutionRecord[]> {
  validateRecoveryOptions(options);
  const now = options.now ?? Date.now();
  const statuses = options.statuses ?? (["running", "waiting"] as const);
  const cutoff = now - options.staleAfterMs;
  const recovered: ExecutionRecord[] = [];

  for (const status of statuses) {
    const candidates = await store.list({ status });
    for (const candidate of candidates) {
      if (candidate.updatedAt > cutoff) continue;
      const patch: Partial<ExecutionRecord> = {
        status: "failed",
        error: "Execution became stale without a heartbeat",
        completedAt: now,
        updatedAt: now,
      };
      const event: ExecutionEvent = {
        type: "run.failed",
        runId: candidate.runId,
        timestamp: now,
        data: { reason: "stale", staleAfterMs: options.staleAfterMs },
      };
      let claimed = false;
      if (store.transition) {
        try {
          await store.transition(candidate.runId, { ...patch, updatedAt: undefined }, event, candidate.updatedAt);
          claimed = true;
        } catch (error) {
          if (error instanceof Error && (error.message.includes("Execution not found") || error.message.includes("Invalid execution status transition") || error.message.includes("Execution changed before transition"))) {
            continue;
          }
          throw error;
        }
      } else if (store.updateIf) {
        claimed = await store.updateIf(candidate.runId, candidate.updatedAt, patch);
        if (claimed) await store.appendEvent(candidate.runId, event);
      } else {
        const latest = await store.get(candidate.runId);
        if (!latest || latest.status !== status || latest.updatedAt !== candidate.updatedAt) continue;
        await store.update(candidate.runId, patch);
        await store.appendEvent(candidate.runId, event);
        claimed = true;
      }
      if (!claimed) continue;
      const record = await store.get(candidate.runId);
      if (record) recovered.push(record);
    }
  }
  return recovered;
}

export async function pruneExecutionHistory(
  store: ExecutionStore,
  options: PruneExecutionHistoryOptions,
): Promise<ExecutionRecord[]> {
  validatePruneOptions(options);
  if (!store.remove) throw new Error("Execution store does not support history removal");
  const now = options.now ?? Date.now();
  const records = await store.list({ status: options.status });
  const cutoff = options.olderThanMs === undefined ? undefined : now - options.olderThanMs;
  const sorted = records.sort((a, b) => a.updatedAt - b.updatedAt);
  const keepFromIndex = options.maxRecords === undefined
    ? sorted.length
    : Math.max(0, sorted.length - options.maxRecords);
  const candidates = sorted.filter((record, index) => {
    const oldEnough = cutoff === undefined || record.updatedAt <= cutoff;
    const overCount = options.maxRecords === undefined || index < keepFromIndex;
    return oldEnough && overCount;
  });
  const removed: ExecutionRecord[] = [];
  for (const record of candidates) {
    if (await store.remove(record.runId)) removed.push(record);
  }
  return removed;
}
