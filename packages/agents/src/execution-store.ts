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

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly records = new Map<string, ExecutionRecord>();

  create(record: ExecutionRecord): void {
    if (this.records.has(record.runId)) throw new Error("Execution already exists: " + record.runId);
    this.records.set(record.runId, { ...record, events: [...record.events] });
  }

  update(runId: string, patch: Partial<ExecutionRecord>): void {
    const current = this.records.get(runId);
    if (!current) throw new Error("Execution not found: " + runId);
    this.records.set(runId, { ...current, ...patch, events: patch.events ? [...patch.events] : current.events });
  }

  appendEvent(runId: string, event: ExecutionEvent): void {
    const current = this.records.get(runId);
    if (!current) return;
    this.records.set(runId, {
      ...current,
      updatedAt: event.timestamp,
      events: [...current.events, event],
    });
  }

  get(runId: string): ExecutionRecord | undefined {
    const record = this.records.get(runId);
    return record ? { ...record, events: [...record.events] } : undefined;
  }

  list(options: { status?: ExecutionStatus; limit?: number } = {}): ExecutionRecord[] {
    const records = [...this.records.values()]
      .filter((record) => options.status === undefined || record.status === options.status)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const limit = options.limit ?? records.length;
    return records.slice(0, Math.max(0, limit)).map((record) => ({ ...record, events: [...record.events] }));
  }
}
