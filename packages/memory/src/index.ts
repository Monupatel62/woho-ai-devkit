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
}

export class InMemoryStore implements MemoryStore {
  private readonly messages: MemoryMessage[] = [];
  private readonly maxMessages: number;

  constructor(options: MemoryOptions = {}) {
    this.maxMessages = options.maxMessages ?? 100;
    if (!Number.isInteger(this.maxMessages) || this.maxMessages < 1) throw new Error("maxMessages must be a positive integer");
  }

  async add(message: MemoryMessage): Promise<void> {
    if (!message || typeof message !== "object") throw new Error("Memory message is required");
    if (!message.id.trim()) throw new Error("Memory message id is required");
    if (!message.content.trim()) throw new Error("Memory message content is required");
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
  if (!Number.isInteger(options.maxCharacters) || options.maxCharacters < 1) throw new Error("maxCharacters must be a positive integer");
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  const source = options.sessionId ? messages.filter((m) => m.metadata?.sessionId === options.sessionId) : messages;
  const content = await summarizer.summarize(source, { maxCharacters: options.maxCharacters });
  if (!content.trim()) throw new Error("Memory summarizer returned empty content");
  return { id: "summary-" + Date.now(), role: "system", content: content.slice(0, options.maxCharacters), timestamp: Date.now(), metadata: options.sessionId ? { sessionId: options.sessionId, summary: true } : { summary: true } };
}

export function summarizeMemory(messages: MemoryMessage[], options: MemorySummaryOptions): MemoryMessage {
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
