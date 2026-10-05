import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { MemoryMessage, MemoryQuery, MemoryStore } from "./index.js";

export interface JsonFileStoreOptions {
  filePath: string;
  maxMessages?: number;
}

export class JsonFileStore implements MemoryStore {
  private readonly filePath: string;
  private readonly maxMessages: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: JsonFileStoreOptions) {
    if (!options.filePath.trim()) throw new Error("filePath is required");
    this.filePath = options.filePath;
    this.maxMessages = options.maxMessages ?? 1000;
    if (!Number.isInteger(this.maxMessages) || this.maxMessages < 1) throw new Error("maxMessages must be a positive integer");
  }

  private async load(): Promise<MemoryMessage[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Memory file must contain an array");
      return parsed as MemoryMessage[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async persist(messages: MemoryMessage[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = this.filePath + ".tmp";
    await writeFile(temp, JSON.stringify(messages), "utf8");
    await rename(temp, this.filePath);
  }

  async add(message: MemoryMessage): Promise<void> {
    if (!message.id.trim()) throw new Error("Memory message id is required");
    if (!message.content.trim()) throw new Error("Memory message content is required");
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
    const limit = query.limit ?? this.maxMessages;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    const messages = await this.load();
    const filtered = (query.before === undefined ? messages : messages.filter((m) => (m.timestamp ?? 0) < query.before!)).filter((m) => query.sessionId === undefined || m.metadata?.sessionId === query.sessionId);
    return filtered.slice(Math.max(0, filtered.length - limit)).map((m) => ({ ...m, metadata: m.metadata ? { ...m.metadata } : undefined }));
  }

  async clear(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.persist([]));
    return this.writeQueue;
  }
}

export function createJsonFileStore(options: JsonFileStoreOptions): MemoryStore {
  return new JsonFileStore(options);
}
