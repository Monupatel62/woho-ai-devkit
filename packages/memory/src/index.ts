export interface MemoryMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryQuery {
  limit?: number;
  before?: number;
  sessionId?: string;
}

export interface MemoryStore {
  add(message: MemoryMessage): Promise<void>;
  list(query?: MemoryQuery): Promise<MemoryMessage[]>;
  clear(): Promise<void>;
  delete?(id: string): Promise<void>;
}

export interface MemoryOptions {
  maxMessages?: number;
  maxMetadataBytes?: number;
  maxMetadataDepth?: number;
}

export function validateMemoryMetadata(metadata: Record<string, unknown> | undefined, maxBytes: number, maxDepth: number): void {
  if (metadata === undefined) return;
  const seen = new WeakSet<object>();
  let bytes = 2;
  const visit = (value: unknown, depth: number): void => {
    if (depth > maxDepth) throw new Error("Memory metadata exceeds maxMetadataDepth");
    if (value === null) { bytes += 4; return; }
    if (typeof value === "string") { bytes += Buffer.byteLength(JSON.stringify(value), "utf8"); return; }
    if (typeof value === "number" || typeof value === "boolean") { bytes += Buffer.byteLength(JSON.stringify(value), "utf8"); return; }
    if (typeof value !== "object") throw new Error("Memory metadata contains an unsupported value");
    if (seen.has(value)) throw new Error("Memory metadata must not contain circular references");
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) { bytes += 1; visit(item, depth + 1); }
    } else {
      for (const [key, item] of Object.entries(value)) {
        bytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
        visit(item, depth + 1);
      }
    }
    seen.delete(value);
    if (bytes > maxBytes) throw new Error("Memory metadata exceeds maxMetadataBytes");
  };
  visit(metadata, 0);
  if (bytes > maxBytes) throw new Error("Memory metadata exceeds maxMetadataBytes");
}

export class InMemoryStore implements MemoryStore {
  private readonly messages: MemoryMessage[] = [];
  private readonly maxMessages: number;
  private readonly maxMetadataBytes: number;
  private readonly maxMetadataDepth: number;

  constructor(options: MemoryOptions = {}) {
    this.maxMessages = options.maxMessages ?? 100;
    this.maxMetadataBytes = options.maxMetadataBytes ?? 256 * 1024;
    this.maxMetadataDepth = options.maxMetadataDepth ?? 10;
    if (!Number.isInteger(this.maxMessages) || this.maxMessages < 1) throw new Error("maxMessages must be a positive integer");
    if (!Number.isInteger(this.maxMetadataBytes) || this.maxMetadataBytes < 1) throw new Error("maxMetadataBytes must be a positive integer");
    if (!Number.isInteger(this.maxMetadataDepth) || this.maxMetadataDepth < 1) throw new Error("maxMetadataDepth must be a positive integer");
  }

  async add(message: MemoryMessage): Promise<void> {
    if (!message || typeof message !== "object") throw new Error("Memory message is required");
    if (typeof message.id !== "string" || !message.id.trim()) throw new Error("Memory message id is required");
    if (typeof message.content !== "string") throw new Error("Memory message content is required");
    if (!["system", "user", "assistant", "tool"].includes(message.role)) throw new Error("Memory message role is invalid");
    if (message.timestamp !== undefined && !Number.isFinite(message.timestamp)) throw new Error("Memory message timestamp must be finite");
    validateMemoryMetadata(message.metadata, this.maxMetadataBytes, this.maxMetadataDepth);
    this.messages.push({ ...message, metadata: message.metadata ? { ...message.metadata } : undefined });
    while (this.messages.length > this.maxMessages) this.messages.shift();
  }

  async list(query: MemoryQuery = {}): Promise<MemoryMessage[]> {
    if (query.before !== undefined && !Number.isFinite(query.before)) throw new Error("before must be a finite number");
    if (query.sessionId !== undefined && !query.sessionId.trim()) throw new Error("sessionId cannot be empty");
    const limit = query.limit ?? this.maxMessages;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    let items = query.before === undefined ? [...this.messages] : this.messages.filter((m) => (m.timestamp ?? 0) < query.before!);
    if (query.sessionId !== undefined) items = items.filter((m) => m.metadata?.sessionId === query.sessionId);
    return items.slice(Math.max(0, items.length - limit)).map((m) => ({ ...m, metadata: m.metadata ? { ...m.metadata } : undefined }));
  }

  async delete(id: string): Promise<void> {
    if (!id.trim()) throw new Error("id is required");
    const index = this.messages.findIndex((message) => message.id === id);
    if (index >= 0) this.messages.splice(index, 1);
  }

  async clear(): Promise<void> {
    this.messages.length = 0;
  }
}

export interface MemorySummarizer {
  summarize(messages: MemoryMessage[], options?: { maxCharacters?: number }): Promise<string>;
}

export interface MemorySummaryOptions {
  maxCharacters: number;
  sessionId?: string;
}

export async function summarizeMemoryWith(summarizer: MemorySummarizer, messages: MemoryMessage[], options: MemorySummaryOptions): Promise<MemoryMessage> {
  if (!summarizer || typeof summarizer.summarize !== "function") throw new Error("summarizer is required");
  if (!Number.isInteger(options.maxCharacters) || options.maxCharacters < 1) throw new Error("maxCharacters must be a positive integer");
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const source = options.sessionId ? messages.filter((m) => m.metadata?.sessionId === options.sessionId) : messages;
  const content = await summarizer.summarize(source, { maxCharacters: options.maxCharacters });
  if (!content.trim()) throw new Error("Memory summarizer returned empty content");
  return { id: "summary-" + Date.now(), role: "system", content: content.slice(0, options.maxCharacters), timestamp: Date.now(), metadata: options.sessionId ? { sessionId: options.sessionId, summary: true } : { summary: true } };
}

export function summarizeMemory(messages: MemoryMessage[], options: MemorySummaryOptions): MemoryMessage {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  if (!Number.isInteger(options.maxCharacters) || options.maxCharacters < 1) throw new Error("maxCharacters must be a positive integer");
  const source = options.sessionId ? messages.filter((m) => m.metadata?.sessionId === options.sessionId) : messages;
  const lines: string[] = [];
  let used = 0;
  for (const message of source) {
    const line = message.role + ": " + message.content.replace(/\s+/g, " ").trim();
    const next = used + line.length + 1;
    if (next > options.maxCharacters) break;
    lines.push(line);
    used = next;
  }
  return { id: "summary-" + Date.now(), role: "system", content: lines.join("\n"), timestamp: Date.now(), metadata: options.sessionId ? { sessionId: options.sessionId, summary: true } : { summary: true } };
}

export function createInMemoryStore(options?: MemoryOptions): MemoryStore {
  return new InMemoryStore(options);
}

export { createJsonFileStore, JsonFileStore, type JsonFileStoreOptions } from "./json.js";
export { Conversation, createConversation, type ConversationOptions, type MemorySearchOptions } from "./conversation.js";
export { searchMemory, type MemorySearchResult } from "./search.js";

export { searchMemorySemantic, type MemoryEmbedder, type SemanticMemoryResult } from "./vector.js";
