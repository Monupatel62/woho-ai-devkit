import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { validateMemoryMetadata, type MemoryMessage, type MemoryQuery, type MemoryStore } from "./index.js";

export interface JsonFileStoreOptions {
  filePath: string;
  maxMessages?: number;
  maxFileBytes?: number;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  lockStaleMs?: number;
  maxMetadataBytes?: number;
  maxMetadataDepth?: number;
}

export class JsonFileStore implements MemoryStore {
  private readonly filePath: string;
  private readonly maxMessages: number;
  private readonly maxFileBytes: number;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly lockStaleMs: number;
  private readonly maxMetadataBytes: number;
  private readonly maxMetadataDepth: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonFileStoreOptions) {
    if (!options.filePath.trim()) throw new Error("filePath is required");
    this.filePath = options.filePath;
    this.maxMessages = options.maxMessages ?? 1000;
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.lockRetryMs = options.lockRetryMs ?? 25;
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
    this.maxMetadataBytes = options.maxMetadataBytes ?? 256 * 1024;
    this.maxMetadataDepth = options.maxMetadataDepth ?? 10;
    if (!Number.isInteger(this.maxMessages) || this.maxMessages < 1) throw new Error("maxMessages must be a positive integer");
    if (!Number.isInteger(this.maxFileBytes) || this.maxFileBytes < 1) throw new Error("maxFileBytes must be a positive integer");
    if (!Number.isInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1) throw new Error("lockTimeoutMs must be a positive integer");
    if (!Number.isInteger(this.lockRetryMs) || this.lockRetryMs < 1) throw new Error("lockRetryMs must be a positive integer");
    if (!Number.isInteger(this.lockStaleMs) || this.lockStaleMs < this.lockRetryMs) throw new Error("lockStaleMs must be at least lockRetryMs");
    if (!Number.isInteger(this.maxMetadataBytes) || this.maxMetadataBytes < 1) throw new Error("maxMetadataBytes must be a positive integer");
    if (!Number.isInteger(this.maxMetadataDepth) || this.maxMetadataDepth < 1) throw new Error("maxMetadataDepth must be a positive integer");
  }

  private async load(): Promise<MemoryMessage[]> {
    const validate = (value: unknown): MemoryMessage[] => {
      if (!Array.isArray(value)) throw new Error("Memory file must contain an array");
      for (const message of value) {
        if (!message || typeof message !== "object" || typeof (message as MemoryMessage).id !== "string" || !(message as MemoryMessage).id.trim() || typeof (message as MemoryMessage).content !== "string" || !["system", "user", "assistant", "tool"].includes((message as MemoryMessage).role) || ((message as MemoryMessage).timestamp !== undefined && !Number.isFinite((message as MemoryMessage).timestamp))) {
          throw new Error("Memory file contains an invalid message");
        }
      }
      const messages = value as MemoryMessage[];
      if (messages.length > this.maxMessages) return messages.slice(-this.maxMessages);
      return messages;
    };
    try {
      const { stat } = await import("node:fs/promises");
      const info = await stat(this.filePath);
      if (!info.isFile() || info.size > this.maxFileBytes) throw new Error("Memory file is missing, not a regular file, or too large");
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return validate(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async persist(messages: MemoryMessage[]): Promise<void> {
    const serialized = JSON.stringify(messages);
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > this.maxFileBytes) throw new Error("Memory file exceeds maxFileBytes");
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try { await import("node:fs/promises").then(({ chmod }) => chmod(dirname(this.filePath), 0o700)); } catch { /* best effort */ }
    const temp = this.filePath + ".tmp-" + process.pid + "-" + randomUUID();
    try {
      await writeFile(temp, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.filePath);
    } catch (error) {
      try { await (await import("node:fs/promises")).unlink(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = this.filePath + ".lock";
    const started = Date.now();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    while (!handle) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), "utf8");
        await handle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > this.lockStaleMs) {
            let ownerAlive = false;
            try {
              const raw = await readFile(lockPath, "utf8");
              const metadata = JSON.parse(raw) as { pid?: unknown };
              if (typeof metadata.pid === "number" && Number.isInteger(metadata.pid) && metadata.pid > 0) {
                try {
                  process.kill(metadata.pid, 0);
                  ownerAlive = true;
                } catch (error) {
                  ownerAlive = (error as NodeJS.ErrnoException).code === "EPERM";
                }
              }
            } catch {
              // Malformed or unreadable stale locks are safe to reclaim.
            }
            if (!ownerAlive) await rm(lockPath, { force: true });
          }
        } catch (staleError) {
          if ((staleError as NodeJS.ErrnoException).code !== "ENOENT") throw staleError;
        }
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error("Memory store lock acquisition timed out");
        await new Promise((resolve) => setTimeout(resolve, this.lockRetryMs));
      }
    }
    const heartbeatMs = Math.max(1, Math.floor(this.lockStaleMs / 3));
    const heartbeat = setInterval(() => { void utimes(lockPath, new Date(), new Date()).catch(() => undefined); }, heartbeatMs);
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true });
    }
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.catch(() => undefined).then(() => this.withFileLock(operation));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  async add(message: MemoryMessage): Promise<void> {
    if (!message || typeof message !== "object") throw new Error("Memory message is required");
    if (typeof message.id !== "string" || !message.id.trim()) throw new Error("Memory message id is required");
    if (typeof message.content !== "string") throw new Error("Memory message content is required");
    if (!["system", "user", "assistant", "tool"].includes(message.role)) throw new Error("Memory message role is invalid");
    if (message.timestamp !== undefined && !Number.isFinite(message.timestamp)) throw new Error("Memory message timestamp must be finite");
    if (message.metadata !== undefined && (typeof message.metadata !== "object" || message.metadata === null || Array.isArray(message.metadata))) throw new Error("Memory message metadata must be an object");
    validateMemoryMetadata(message.metadata, this.maxMetadataBytes, this.maxMetadataDepth);
    return this.enqueueWrite(async () => {
      const messages = await this.load();
      messages.push({ ...message, metadata: message.metadata ? { ...message.metadata } : undefined });
      while (messages.length > this.maxMessages) messages.shift();
      await this.persist(messages);
    });
  }

  async list(query: MemoryQuery = {}): Promise<MemoryMessage[]> {
    await this.writeQueue;
    if (query.before !== undefined && !Number.isFinite(query.before)) throw new Error("before must be a finite number");
    if (query.sessionId !== undefined && !query.sessionId.trim()) throw new Error("sessionId cannot be empty");
    const limit = query.limit ?? this.maxMessages;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    const messages = await this.load();
    const filtered = (query.before === undefined ? messages : messages.filter((m) => (m.timestamp ?? 0) < query.before!)).filter((m) => query.sessionId === undefined || m.metadata?.sessionId === query.sessionId);
    return filtered.slice(Math.max(0, filtered.length - limit)).map((m) => ({ ...m, metadata: m.metadata ? { ...m.metadata } : undefined }));
  }

  async delete(id: string): Promise<void> {
    if (!id.trim()) throw new Error("id is required");
    return this.enqueueWrite(async () => {
      const messages = await this.load();
      await this.persist(messages.filter((message) => message.id !== id));
    });
  }

  async clear(): Promise<void> {
    return this.enqueueWrite(() => this.persist([]));
  }
}

export function createJsonFileStore(options: JsonFileStoreOptions): MemoryStore {
  return new JsonFileStore(options);
}
