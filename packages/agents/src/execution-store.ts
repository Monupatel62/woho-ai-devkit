import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExecutionEvent, ExecutionStatus } from "@woho/core";

export interface ExecutionApprovalRecord {
  /** Unique request identity; decisions must target this exact approval. */
  readonly approvalId: string;
  /** Model/tool call identity that triggered the approval. */
  readonly callId: string;
  readonly status: "pending" | "approved" | "denied";
  readonly tool: string;
  readonly capability: string;
  readonly action: string;
  readonly reason?: string;
  readonly requestedAt: number;
  readonly decidedAt?: number;
}

export interface ExecutionCheckpoint {
  readonly step: number;
  readonly messages: readonly import("@woho/core").AIMessage[];
  /** Tool call whose side effect may have started before the last checkpoint. */
  readonly inFlightToolCallId?: string;
  readonly updatedAt: number;
}

export interface ExecutionToolReceipt {
  readonly callId: string;
  readonly fingerprint: string;
  readonly status: "in_flight" | "completed" | "failed";
  readonly result?: string;
  readonly error?: string;
  readonly updatedAt: number;
}

export interface ExecutionLease {
  readonly ownerId: string;
  readonly fencingToken: number;
  readonly expiresAt: number;
}

export interface ExecutionRecord {
  readonly runId: string;
  /** Stable project scope for execution history and authorization boundaries. */
  readonly projectId?: string;
  readonly agent: string;
  /** Original task input; optional for backward compatibility with older records. */
  readonly input?: string;
  /** Child run ID atomically claimed for a durable resume, when one has been started. */
  readonly resumeRunId?: string;
  readonly parentRunId?: string;
  readonly sessionId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  /** Latest approval decision associated with this execution. */
  readonly approval?: ExecutionApprovalRecord;
  /** Durable idempotency receipts for tool side effects. */
  readonly toolReceipts?: Readonly<Record<string, ExecutionToolReceipt>>;
  /** Fenced worker lease for active execution ownership. */
  readonly lease?: ExecutionLease;
  /** Last safe conversation checkpoint for crash recovery. */
  readonly checkpoint?: ExecutionCheckpoint;
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
  list(options?: { status?: ExecutionStatus; projectId?: string; limit?: number }): ExecutionRecord[] | Promise<ExecutionRecord[]>;
  remove?(runId: string): boolean | Promise<boolean>;
  updateIf?(runId: string, expectedUpdatedAt: number, patch: Partial<ExecutionRecord>): boolean | Promise<boolean>;
  /** Atomically claim a single child run for resuming a failed/cancelled execution. */
  claimResume?(runId: string, expectedUpdatedAt: number, resumeRunId: string): string | undefined | Promise<string | undefined>;
  /** Atomically resolve the currently pending approval for a run. */
  resolveApproval?(runId: string, approvalId: string, approved: boolean, reason?: string, decidedAt?: number): boolean | Promise<boolean>;
  /** Atomically apply a record patch and append its lifecycle event. */
  transition?(runId: string, patch: Partial<ExecutionRecord>, event: ExecutionEvent, expectedUpdatedAt?: number): void | Promise<void>;
  claimToolExecution?(runId: string, callId: string, fingerprint: string): ExecutionToolReceipt | undefined | Promise<ExecutionToolReceipt | undefined>;
  completeToolExecution?(runId: string, callId: string, fingerprint: string, patch: { status: "completed" | "failed"; result?: string; error?: string; updatedAt?: number }): boolean | Promise<boolean>;
  acquireLease?(runId: string, ownerId: string, ttlMs: number, now?: number): ExecutionLease | undefined | Promise<ExecutionLease | undefined>;
  renewLease?(runId: string, ownerId: string, fencingToken: number, ttlMs: number, now?: number): boolean | Promise<boolean>;
  releaseLease?(runId: string, ownerId: string, fencingToken: number, now?: number): boolean | Promise<boolean>;
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

function validateRequiredTimestamp(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(name + " must be a non-negative finite number");
  }
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
  return {
    ...record,
    metadata: { ...record.metadata },
    events: [...record.events],
    ...(record.checkpoint ? { checkpoint: { ...record.checkpoint, messages: [...record.checkpoint.messages] } } : {}),
    ...(record.toolReceipts ? { toolReceipts: Object.fromEntries(Object.entries(record.toolReceipts).map(([key, value]) => [key, { ...value }])) } : {}),
    ...(record.lease ? { lease: { ...record.lease } } : {}),
  };
}

function validateApprovalId(approvalId: string): void {
  if (typeof approvalId !== "string" || !approvalId.trim()) throw new Error("Execution approvalId is required");
  if (approvalId.length > 200) throw new Error("Execution approvalId is too long");
}

function validateCallId(callId: string): void {
  if (typeof callId !== "string" || !callId.trim()) throw new Error("Execution approval callId is required");
  if (callId.length > 200) throw new Error("Execution approval callId is too long");
}

function validateRunId(runId: string): void {
  if (typeof runId !== "string" || !runId.trim()) throw new Error("Execution runId is required");
  if (runId.length > 200) throw new Error("Execution runId is too long");
}

const EXECUTION_EVENT_TYPES: readonly ExecutionEvent["type"][] = [
  "run.started",
  "run.waiting",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "tool.started",
  "tool.completed",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateExecutionEvent(event: ExecutionEvent, expectedRunId?: string): void {
  if (!isRecord(event)) throw new Error("Invalid execution event");
  if (typeof event.runId !== "string" || !event.runId.trim()) throw new Error("Invalid execution event runId");
  if (expectedRunId !== undefined && event.runId !== expectedRunId) {
    throw new Error("Execution event runId does not match execution record");
  }
  if (typeof event.type !== "string" || !EXECUTION_EVENT_TYPES.includes(event.type as ExecutionEvent["type"])) {
    throw new Error("Invalid execution event type");
  }
  validateRequiredTimestamp(event.timestamp, "Execution event timestamp");
  if (event.data !== undefined && !isRecord(event.data)) throw new Error("Invalid execution event data");
}

function validateExecutionStatus(status: unknown): asserts status is ExecutionStatus {
  if (typeof status !== "string" || !Object.prototype.hasOwnProperty.call(EXECUTION_TRANSITIONS, status)) {
    throw new Error("Invalid execution status: " + String(status));
  }
}

function validateExecutionRecord(record: ExecutionRecord): void {
  if (!isRecord(record)) throw new Error("Invalid execution record");
  validateRunId(record.runId);
  if (record.projectId !== undefined && (typeof record.projectId !== "string" || !record.projectId.trim())) throw new Error("Invalid execution projectId");
  if (record.projectId !== undefined && record.projectId.length > 200) throw new Error("Execution projectId is too long");
  if (typeof record.agent !== "string" || !record.agent.trim()) throw new Error("Invalid execution agent");
  if (record.input !== undefined && typeof record.input !== "string") throw new Error("Invalid execution input");
  if (record.resumeRunId !== undefined) validateRunId(record.resumeRunId);
  if (record.parentRunId !== undefined) validateRunId(record.parentRunId);
  if (record.sessionId !== undefined && typeof record.sessionId !== "string") throw new Error("Invalid execution sessionId");
  if (!isRecord(record.metadata)) throw new Error("Invalid execution metadata");
  if (record.checkpoint !== undefined) {
    if (!isRecord(record.checkpoint)) throw new Error("Invalid execution checkpoint");
    if (!Number.isInteger(record.checkpoint.step) || record.checkpoint.step < 0) throw new Error("Invalid execution checkpoint step");
    if (!Array.isArray(record.checkpoint.messages)) throw new Error("Invalid execution checkpoint messages");
    if (record.checkpoint.inFlightToolCallId !== undefined && (typeof record.checkpoint.inFlightToolCallId !== "string" || !record.checkpoint.inFlightToolCallId.trim())) {
      throw new Error("Invalid execution checkpoint inFlightToolCallId");
    }
    validateRequiredTimestamp(record.checkpoint.updatedAt, "Execution checkpoint updatedAt");
    if (record.checkpoint.updatedAt > record.updatedAt) throw new Error("Execution checkpoint cannot be newer than execution record");
  }
  if (record.toolReceipts !== undefined) {
    if (!isRecord(record.toolReceipts)) throw new Error("Invalid execution toolReceipts");
    for (const [key, receipt] of Object.entries(record.toolReceipts)) {
      if (!isRecord(receipt) || key !== receipt.callId || typeof receipt.fingerprint !== "string" || !receipt.fingerprint.trim()) throw new Error("Invalid execution tool receipt");
      if (!["in_flight", "completed", "failed"].includes(receipt.status as string)) throw new Error("Invalid execution tool receipt status");
      if (receipt.result !== undefined && typeof receipt.result !== "string") throw new Error("Invalid execution tool receipt result");
      if (receipt.error !== undefined && typeof receipt.error !== "string") throw new Error("Invalid execution tool receipt error");
      validateRequiredTimestamp(receipt.updatedAt, "Execution tool receipt updatedAt");
    }
  }
  if (record.lease !== undefined) {
    if (!isRecord(record.lease) || typeof record.lease.ownerId !== "string" || !record.lease.ownerId.trim() || !Number.isInteger(record.lease.fencingToken) || record.lease.fencingToken < 1) throw new Error("Invalid execution lease");
    validateRequiredTimestamp(record.lease.expiresAt, "Execution lease expiresAt");
  }
  if (record.approval !== undefined) {
    if (!isRecord(record.approval)) throw new Error("Invalid execution approval");
    validateApprovalId(record.approval.approvalId);
    validateCallId(record.approval.callId);
    if (!["pending", "approved", "denied"].includes(record.approval.status)) throw new Error("Invalid execution approval status");
    for (const key of ["tool", "capability", "action"]) if (typeof record.approval[key] !== "string" || !record.approval[key].trim()) throw new Error("Invalid execution approval " + key);
    validateRequiredTimestamp(record.approval.requestedAt, "Execution approval requestedAt");
    validateTimestamp(record.approval.decidedAt, "Execution approval decidedAt");
    if (record.approval.decidedAt !== undefined && record.approval.decidedAt < record.approval.requestedAt) throw new Error("Execution approval decidedAt cannot be before requestedAt");
    if (record.approval.reason !== undefined && typeof record.approval.reason !== "string") throw new Error("Invalid execution approval reason");
    if (record.approval.status === "pending" && record.approval.decidedAt !== undefined) throw new Error("Pending approval cannot have decidedAt");
    if (record.approval.status !== "pending" && record.approval.decidedAt === undefined) throw new Error("Resolved approval requires decidedAt");
  }
  validateExecutionStatus(record.status);
  validateRequiredTimestamp(record.startedAt, "Execution startedAt");
  validateRequiredTimestamp(record.updatedAt, "Execution updatedAt");
  if (record.updatedAt < record.startedAt) throw new Error("Execution updatedAt cannot be before startedAt");
  validateTimestamp(record.completedAt, "Execution completedAt");
  if (record.completedAt !== undefined && record.completedAt < record.startedAt) {
    throw new Error("Execution completedAt cannot be before startedAt");
  }
  if (!Number.isInteger(record.attempts) || record.attempts < 0) throw new Error("Execution attempts must be a non-negative integer");
  if (record.error !== undefined && typeof record.error !== "string") throw new Error("Invalid execution error");
  if (!Array.isArray(record.events)) throw new Error("Invalid execution events");
  for (const event of record.events) validateExecutionEvent(event, record.runId);
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
  validateExecutionStatus(current.status);
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

export interface InMemoryExecutionStoreOptions {
  /** Maximum number of lifecycle events retained per execution. Defaults to 1000. */
  readonly maxEvents?: number;
}

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly maxEvents: number;

  constructor(options: InMemoryExecutionStoreOptions = {}) {
    this.maxEvents = options.maxEvents ?? 1_000;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) throw new Error("maxEvents must be a positive integer");
  }

  create(record: ExecutionRecord): void {
    validateExecutionRecord(record);
    if (this.records.has(record.runId)) throw new Error("Execution already exists: " + record.runId);
    this.records.set(record.runId, cloneRecord(record));
  }

  update(runId: string, patch: Partial<ExecutionRecord>): void {
    validateRunId(runId);
    const current = this.records.get(runId);
    if (!current) throw new Error("Execution not found: " + runId);
    validateExecutionTransition(current, patch.status);
    const next = { ...current, ...patch, events: patch.events ? [...patch.events] : current.events };
    validateExecutionRecord(next);
    this.records.set(runId, cloneRecord(next));
  }

  appendEvent(runId: string, event: ExecutionEvent): void {
    validateRunId(runId);
    const current = this.records.get(runId);
    if (!current) return;
    validateExecutionEvent(event, runId);
    this.records.set(runId, this.withAppendedEvent(current, event));
  }

  transition(runId: string, patch: Partial<ExecutionRecord>, event: ExecutionEvent, expectedUpdatedAt?: number): void {
    validateRunId(runId);
    const current = this.records.get(runId);
    if (!current) throw new Error("Execution not found: " + runId);
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) throw new Error("Execution changed before transition: " + runId);
    validateExecutionTransition(current, patch.status);
    validateExecutionEvent(event, runId);
    const next = {
      ...current,
      ...patch,
      updatedAt: Math.max(current.updatedAt, event.timestamp),
      events: this.withAppendedEvent(current, event).events,
    };
    validateExecutionRecord(next);
    this.records.set(runId, cloneRecord(next));
  }

  private withAppendedEvent(record: ExecutionRecord, event: ExecutionEvent): ExecutionRecord {
    const events = [...record.events, event];
    if (events.length > this.maxEvents) events.splice(0, events.length - this.maxEvents);
    return { ...record, updatedAt: Math.max(record.updatedAt, event.timestamp), events };
  }

  get(runId: string): ExecutionRecord | undefined {
    validateRunId(runId);
    const record = this.records.get(runId);
    return record ? cloneRecord(record) : undefined;
  }

  list(options: { status?: ExecutionStatus; projectId?: string; limit?: number } = {}): ExecutionRecord[] {
    validateLimit(options.limit);
    const records = [...this.records.values()]
      .filter((record) => options.status === undefined || record.status === options.status)
      .filter((record) => options.projectId === undefined || record.projectId === options.projectId)
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
    const next = { ...current, ...patch, events: patch.events ? [...patch.events] : current.events };
    try { validateExecutionRecord(next); } catch { return false; }
    this.records.set(runId, cloneRecord(next));
    return true;
  }


  claimToolExecution(runId: string, callId: string, fingerprint: string): ExecutionToolReceipt | undefined {
    validateRunId(runId); validateCallId(callId); if (!fingerprint.trim()) throw new Error("Tool execution fingerprint is required");
    const current = this.records.get(runId); if (!current) throw new Error("Execution not found: " + runId);
    const existing = current.toolReceipts?.[callId];
    if (existing) { if (existing.fingerprint !== fingerprint) throw new Error("Tool execution fingerprint conflict: " + callId); return cloneRecord({ ...current }).toolReceipts?.[callId]; }
    const receipt: ExecutionToolReceipt = { callId, fingerprint, status: "in_flight", updatedAt: Date.now() };
    this.records.set(runId, cloneRecord({ ...current, toolReceipts: { ...(current.toolReceipts ?? {}), [callId]: receipt }, updatedAt: receipt.updatedAt }));
    return receipt;
  }

  completeToolExecution(runId: string, callId: string, fingerprint: string, patch: { status: "completed" | "failed"; result?: string; error?: string; updatedAt?: number }): boolean {
    validateRunId(runId); validateCallId(callId); const current = this.records.get(runId); if (!current) return false;
    const receipt = current.toolReceipts?.[callId]; if (!receipt || receipt.fingerprint !== fingerprint || receipt.status !== "in_flight") return false;
    const updatedAt = patch.updatedAt ?? Date.now();
    const nextReceipt = { ...receipt, ...patch, updatedAt };
    this.records.set(runId, cloneRecord({ ...current, toolReceipts: { ...(current.toolReceipts ?? {}), [callId]: nextReceipt }, updatedAt })); return true;
  }

  acquireLease(runId: string, ownerId: string, ttlMs: number, now = Date.now()): ExecutionLease | undefined {
    validateRunId(runId); if (!ownerId.trim() || !Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("Invalid execution lease request");
    const current = this.records.get(runId); if (!current) throw new Error("Execution not found: " + runId);
    if (current.lease && current.lease.expiresAt > now && current.lease.ownerId !== ownerId) return undefined;
    const lease = { ownerId, fencingToken: (current.lease?.fencingToken ?? 0) + 1, expiresAt: now + ttlMs };
    this.records.set(runId, cloneRecord({ ...current, lease, updatedAt: now })); return lease;
  }

  renewLease(runId: string, ownerId: string, fencingToken: number, ttlMs: number, now = Date.now()): boolean {
    const current = this.records.get(runId); if (!current?.lease || current.lease.ownerId !== ownerId || current.lease.fencingToken !== fencingToken || current.lease.expiresAt < now) return false;
    const lease = { ...current.lease, expiresAt: now + ttlMs }; this.records.set(runId, cloneRecord({ ...current, lease, updatedAt: now })); return true;
  }

  releaseLease(runId: string, ownerId: string, fencingToken: number, now = Date.now()): boolean {
    const current = this.records.get(runId); if (!current?.lease || current.lease.ownerId !== ownerId || current.lease.fencingToken !== fencingToken) return false;
    this.records.set(runId, cloneRecord({ ...current, lease: { ...current.lease, expiresAt: now }, updatedAt: now })); return true;
  }

  resolveApproval(runId: string, approvalId: string, approved: boolean, reason?: string, decidedAt = Date.now()): boolean {
    validateRunId(runId);
    validateApprovalId(approvalId);
    if (typeof approved !== "boolean") throw new Error("Approval decision must be boolean");
    validateRequiredTimestamp(decidedAt, "Execution approval decidedAt");
    const current = this.records.get(runId);
    if (!current?.approval || current.approval.status !== "pending" || current.approval.approvalId !== approvalId) return false;
    if (decidedAt < current.approval.requestedAt) throw new Error("Execution approval decidedAt cannot be before requestedAt");
    const next: ExecutionRecord = {
      ...current,
      approval: {
        ...current.approval,
        status: approved ? "approved" : "denied",
        ...(reason ? { reason } : {}),
        decidedAt,
      },
      status: current.status === "waiting" ? "running" : current.status,
      updatedAt: decidedAt,
    };
    validateExecutionRecord(next);
    this.records.set(runId, cloneRecord(next));
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
  /** Maximum number of lifecycle events retained per execution. Defaults to 1000. */
  readonly maxEvents?: number;
  readonly maxRecordBytes?: number;
  /** Maximum time to wait for the cross-process store lock. */
  readonly lockTimeoutMs?: number;
  /** Delay between cross-process lock acquisition attempts. */
  readonly lockRetryMs?: number;
  /** Lock files older than this are considered abandoned after a process crash. */
  readonly lockStaleMs?: number;
}

export class FileExecutionStore implements ExecutionStore {
  private readonly directory: string;
  private readonly maxEvents: number;
  private readonly maxRecordBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly lockStaleMs: number;

  constructor(options: FileExecutionStoreOptions) {
    if (!options.directory.trim()) throw new Error("Execution store directory is required");
    this.directory = path.resolve(options.directory);
    this.maxEvents = options.maxEvents ?? 1_000;
    this.maxRecordBytes = options.maxRecordBytes ?? 5_000_000;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.lockRetryMs = options.lockRetryMs ?? 25;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents < 1) throw new Error("maxEvents must be a positive integer");
    if (!Number.isInteger(this.maxRecordBytes) || this.maxRecordBytes < 1) {
      throw new Error("maxRecordBytes must be a positive integer");
    }
    if (!Number.isInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1) throw new Error("lockTimeoutMs must be a positive integer");
    if (!Number.isInteger(this.lockRetryMs) || this.lockRetryMs < 1) throw new Error("lockRetryMs must be a positive integer");
    if (!Number.isInteger(this.lockStaleMs) || this.lockStaleMs < this.lockRetryMs) throw new Error("lockStaleMs must be at least lockRetryMs");
  }

  async create(record: ExecutionRecord): Promise<void> {
    validateRunId(record.runId);
    await this.enqueue(() => this.withFileLock(async () => {
      await this.ensureDirectory();
      const target = this.filePath(record.runId);
      try {
        await fs.access(target);
        throw new Error("Execution already exists: " + record.runId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      validateExecutionRecord(record);
      await this.writeRecord(target, cloneRecord(record), false);
    }));
  }

  async update(runId: string, patch: Partial<ExecutionRecord>): Promise<void> {
    validateRunId(runId);
    await this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current) throw new Error("Execution not found: " + runId);
      validateExecutionTransition(current, patch.status);
      const next = { ...current, ...patch, events: patch.events ? [...patch.events] : current.events };
      validateExecutionRecord(next);
      await this.writeRecord(target, cloneRecord(next), true);
    }));
  }

  async appendEvent(runId: string, event: ExecutionEvent): Promise<void> {
    validateRunId(runId);
    await this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current) return;
      validateExecutionEvent(event, runId);
      await this.writeRecord(target, this.withAppendedEvent(current, event), true);
    }));
  }

  async transition(runId: string, patch: Partial<ExecutionRecord>, event: ExecutionEvent, expectedUpdatedAt?: number): Promise<void> {
    validateRunId(runId);
    await this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current) throw new Error("Execution not found: " + runId);
      if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) throw new Error("Execution changed before transition: " + runId);
      validateExecutionTransition(current, patch.status);
      validateExecutionEvent(event, runId);
      const next = {
        ...current,
        ...patch,
        updatedAt: event.timestamp,
        events: this.withAppendedEvent(current, event).events,
      };
      validateExecutionRecord(next);
      await this.writeRecord(target, next, true);
    }));
  }

  async get(runId: string): Promise<ExecutionRecord | undefined> {
    validateRunId(runId);
    return this.readRecord(this.filePath(runId));
  }

  async list(options: { status?: ExecutionStatus; projectId?: string; limit?: number } = {}): Promise<ExecutionRecord[]> {
    validateLimit(options.limit);
    await this.ensureDirectory();
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const records: ExecutionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const record = await this.readRecord(path.join(this.directory, entry.name));
      if (!record) continue;
      if (options.status !== undefined && record.status !== options.status) continue;
      if (options.projectId !== undefined && record.projectId !== options.projectId) continue;
      records.push(record);
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    return records.slice(0, options.limit ?? records.length).map(cloneRecord);
  }

  async remove(runId: string): Promise<boolean> {
    validateRunId(runId);
    return this.enqueue(() => this.withFileLock(async () => {
      try {
        await fs.unlink(this.filePath(runId));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }));
  }

  async updateIf(runId: string, expectedUpdatedAt: number, patch: Partial<ExecutionRecord>): Promise<boolean> {
    validateRunId(runId);
    return this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current || current.updatedAt !== expectedUpdatedAt) return false;
      try { validateExecutionTransition(current, patch.status); } catch { return false; }
      const next = { ...current, ...patch, events: patch.events ? [...patch.events] : current.events };
      try { validateExecutionRecord(next); } catch { return false; }
      await this.writeRecord(target, cloneRecord(next), true);
      return true;
    }));
  }


  async claimToolExecution(runId: string, callId: string, fingerprint: string): Promise<ExecutionToolReceipt | undefined> {
    validateRunId(runId); validateCallId(callId); if (!fingerprint.trim()) throw new Error("Tool execution fingerprint is required");
    return this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId); const current = await this.readRecord(target); if (!current) throw new Error("Execution not found: " + runId);
      const existing = current.toolReceipts?.[callId];
      if (existing) { if (existing.fingerprint !== fingerprint) throw new Error("Tool execution fingerprint conflict: " + callId); return existing; }
      const receipt: ExecutionToolReceipt = { callId, fingerprint, status: "in_flight", updatedAt: Date.now() };
      await this.writeRecord(target, cloneRecord({ ...current, toolReceipts: { ...(current.toolReceipts ?? {}), [callId]: receipt }, updatedAt: receipt.updatedAt }), true); return receipt;
    }));
  }

  async completeToolExecution(runId: string, callId: string, fingerprint: string, patch: { status: "completed" | "failed"; result?: string; error?: string; updatedAt?: number }): Promise<boolean> {
    validateRunId(runId); validateCallId(callId);
    return this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId); const current = await this.readRecord(target); const receipt = current?.toolReceipts?.[callId];
      if (!current || !receipt || receipt.fingerprint !== fingerprint || receipt.status !== "in_flight") return false;
      const updatedAt = patch.updatedAt ?? Date.now(); const nextReceipt = { ...receipt, ...patch, updatedAt };
      await this.writeRecord(target, cloneRecord({ ...current, toolReceipts: { ...(current.toolReceipts ?? {}), [callId]: nextReceipt }, updatedAt }), true); return true;
    }));
  }

  async acquireLease(runId: string, ownerId: string, ttlMs: number, now = Date.now()): Promise<ExecutionLease | undefined> {
    validateRunId(runId); if (!ownerId.trim() || !Number.isInteger(ttlMs) || ttlMs < 1) throw new Error("Invalid execution lease request");
    return this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId); const current = await this.readRecord(target); if (!current) throw new Error("Execution not found: " + runId);
      if (current.lease && current.lease.expiresAt > now && current.lease.ownerId !== ownerId) return undefined;
      const lease = { ownerId, fencingToken: (current.lease?.fencingToken ?? 0) + 1, expiresAt: now + ttlMs };
      await this.writeRecord(target, cloneRecord({ ...current, lease, updatedAt: now }), true); return lease;
    }));
  }

  async renewLease(runId: string, ownerId: string, fencingToken: number, ttlMs: number, now = Date.now()): Promise<boolean> {
    validateRunId(runId);
    return this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId); const current = await this.readRecord(target); if (!current?.lease || current.lease.ownerId !== ownerId || current.lease.fencingToken !== fencingToken || current.lease.expiresAt < now) return false;
      const lease = { ...current.lease, expiresAt: now + ttlMs }; await this.writeRecord(target, cloneRecord({ ...current, lease, updatedAt: now }), true); return true;
    }));
  }

  async releaseLease(runId: string, ownerId: string, fencingToken: number, now = Date.now()): Promise<boolean> {
    validateRunId(runId);
    return this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId); const current = await this.readRecord(target); if (!current?.lease || current.lease.ownerId !== ownerId || current.lease.fencingToken !== fencingToken) return false;
      await this.writeRecord(target, cloneRecord({ ...current, lease: { ...current.lease, expiresAt: now }, updatedAt: now }), true); return true;
    }));
  }

  async resolveApproval(runId: string, approvalId: string, approved: boolean, reason?: string, decidedAt = Date.now()): Promise<boolean> {
    validateRunId(runId);
    validateApprovalId(approvalId);
    if (typeof approved !== "boolean") throw new Error("Approval decision must be boolean");
    validateRequiredTimestamp(decidedAt, "Execution approval decidedAt");
    return this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current?.approval || current.approval.status !== "pending" || current.approval.approvalId !== approvalId) return false;
      if (decidedAt < current.approval.requestedAt) throw new Error("Execution approval decidedAt cannot be before requestedAt");
      const next: ExecutionRecord = {
        ...current,
        approval: {
          ...current.approval,
          status: approved ? "approved" : "denied",
          ...(reason ? { reason } : {}),
          decidedAt,
        },
        status: current.status === "waiting" ? "running" : current.status,
        updatedAt: decidedAt,
      };
      validateExecutionRecord(next);
      await this.writeRecord(target, cloneRecord(next), true);
      return true;
    }));
  }

  async claimResume(runId: string, expectedUpdatedAt: number, resumeRunId: string): Promise<string | undefined> {
    validateRunId(runId);
    validateRunId(resumeRunId);
    return this.enqueue(() => this.withFileLock(async () => {
      const target = this.filePath(runId);
      const current = await this.readRecord(target);
      if (!current || (current.status !== "failed" && current.status !== "cancelled")) return undefined;
      if (current.resumeRunId) return current.resumeRunId;
      if (current.updatedAt !== expectedUpdatedAt) return undefined;
      await this.writeRecord(target, cloneRecord({ ...current, resumeRunId, updatedAt: Date.now() }), true);
      return resumeRunId;
    }));
  }

  private lockPath(): string {
    return path.join(this.directory, ".execution-store.lock");
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectory();
    const lock = this.lockPath();
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const handle = await fs.open(lock, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        const heartbeatMs = Math.max(1, Math.floor(this.lockStaleMs / 3));
        const heartbeat = setInterval(() => {
          void fs.utimes(lock, new Date(), new Date()).catch(() => undefined);
        }, heartbeatMs);
        try {
          return await operation();
        } finally {
          clearInterval(heartbeat);
          await fs.rm(lock, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(lock);
          if (Date.now() - stat.mtimeMs >= this.lockStaleMs) {
            await fs.rm(lock, { force: true });
            continue;
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
          continue;
        }
        if (Date.now() >= deadline) throw new Error("Timed out acquiring execution store lock");
        await new Promise((resolve) => setTimeout(resolve, this.lockRetryMs));
      }
    }
  }

  private withAppendedEvent(record: ExecutionRecord, event: ExecutionEvent): ExecutionRecord {
    const events = [...record.events, event];
    if (events.length > this.maxEvents) events.splice(0, events.length - this.maxEvents);
    return { ...record, updatedAt: event.timestamp, events };
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
      validateExecutionRecord(parsed);
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
