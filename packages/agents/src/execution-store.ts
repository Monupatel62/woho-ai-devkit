import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ExecutionEvent, ExecutionStatus } from "@woho/core";

export interface ExecutionRecord {
  readonly runId: string;
  readonly agent: string;
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
}

function cloneRecord(record: ExecutionRecord): ExecutionRecord {
  return { ...record, metadata: { ...record.metadata }, events: [...record.events] };
}

function validateRunId(runId: string): void {
  if (!runId.trim()) throw new Error("Execution runId is required");
  if (runId.length > 200) throw new Error("Execution runId is too long");
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
    this.records.set(runId, cloneRecord({ ...current, ...patch, events: patch.events ? [...patch.events] : current.events }));
  }

  appendEvent(runId: string, event: ExecutionEvent): void {
    validateRunId(runId);
    const current = this.records.get(runId);
    if (!current) return;
    this.records.set(runId, { ...current, updatedAt: event.timestamp, events: [...current.events, event] });
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

  private filePath(runId: string): string {
    return path.join(this.directory, Buffer.from(runId, "utf8").toString("base64url") + ".json");
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  private async readRecord(file: string): Promise<ExecutionRecord | undefined> {
    try {
      const stat = await fs.stat(file);
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
