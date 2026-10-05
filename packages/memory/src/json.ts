import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryMessage, MemoryQuery, MemoryStore } from "./index.js";

export interface JsonFileStoreOptions {
  filePath: string;
  maxMessages?: number;
  maxFileBytes?: number;
}

export class JsonFileStore implements MemoryStore {
  private readonly filePath: string;
  private readonly maxMessages: number;
  private readonly maxFileBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonFileStoreOptions) {
    if (!options.filePath.trim()) throw new Error("filePath is required");
    this.filePath = options.filePath;
    this.maxMessages = options.maxMessages ?? 1000;
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
    if (!Number.isInteger(this.maxMessages) || this.maxMessages < 1) throw new Error("maxMessages must be a positive integer");
    if (!Number.isInteger(this.maxFileBytes) || this.maxFileBytes < 1) throw new Error("maxFileBytes must be a positive integer");
  }

  private async load(): Promise<MemoryMessage[]> {
    const validate = (value: unknown): MemoryMessage[] => {
      if (!Array.isArray(value)) throw new Error("Memory file must contain an array");
      for (const message of value) {
        if (!message || typeof message !== "object" || typeof (message as MemoryMessage).id !== "string" || !(message as MemoryMessage).id.trim() || typeof (message as MemoryMessage).content !== "string" || !(message as MemoryMessage).content.trim() || !["system", "user", "assistant", "tool"].includes((message as MemoryMessage).role) || ((message as MemoryMessage).timestamp !== undefined && !Number.isFinite((message as MemoryMessage).timestamp))) {
          throw new Error("Memory file contains an invalid message");
        }
      }
      return value as MemoryMessage[];
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
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = this.filePath + ".tmp-" + process.pid + "-" + randomUUID();
    try {
      await writeFile(temp, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.filePath);
    } catch (error) {
      try { await (await import("node:fs/promises")).unlink(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  async add(message: MemoryMessage): Promise<void> {
    if (!message || typeof message !== "object") throw new Error("Memory message is required");
    if (typeof message.id !== "string" || !message.id.trim()) throw new Error("Memory message id is required");
    if (typeof message.content !== "string" || !message.content.trim()) throw new Error("Memory message content is required");
    if (!["system", "user", "assistant", "tool"].includes(message.role)) throw new Error("Memory message role is invalid");
    if (message.timestamp !== undefined && !Number.isFinite(message.timestamp)) throw new Error("Memory message timestamp must be finite");
    if (message.metadata !== undefined && (typeof message.metadata !== "object" || message.metadata === null || Array.isArray(message.metadata))) throw new Error("Memory message metadata must be an object");
    this.writeQueue = this.writeQueue.then(async () => {
      const messages = await this.load();
      messages.push({ ...message, metadata: message.metadata ? { ...message.metadata } : undefined });
      while (messages.length > this.maxMessages) messages.shift();
      await this.persist(messages);
    });
    return this.writeQueue;
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
    this.writeQueue = this.writeQueue.then(async () => {
      const messages = await this.load();
      await this.persist(messages.filter((message) => message.id !== id));
    });
    return this.writeQueue;
  }

  async clear(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.persist([]));
    return this.writeQueue;
  }
}

export function createJsonFileStore(options: JsonFileStoreOptions): MemoryStore {
  return new JsonFileStore(options);
}
