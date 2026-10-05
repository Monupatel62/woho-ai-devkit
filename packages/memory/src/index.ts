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
    if (!Number.isInteger(this.maxMessages) || this.maxMessages < 1) {
      throw new Error("maxMessages must be a positive integer");
    }
  }

  async add(message: MemoryMessage): Promise<void> {
    if (!message.id.trim()) throw new Error("Memory message id is required");
    if (!message.content.trim()) throw new Error("Memory message content is required");
    this.messages.push({ ...message, metadata: message.metadata ? { ...message.metadata } : undefined });
    while (this.messages.length > this.maxMessages) this.messages.shift();
  }

  async list(query: MemoryQuery = {}): Promise<MemoryMessage[]> {
    const limit = query.limit ?? this.maxMessages;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    let items = query.before === undefined ? [...this.messages] : this.messages.filter((m) => (m.timestamp ?? 0) < query.before!);
    return items.slice(Math.max(0, items.length - limit)).map((m) => ({ ...m, metadata: m.metadata ? { ...m.metadata } : undefined }));
  }

  async clear(): Promise<void> {
    this.messages.length = 0;
  }
}

export function createInMemoryStore(options?: MemoryOptions): MemoryStore {
  return new InMemoryStore(options);
}
\nexport { createJsonFileStore, JsonFileStore, type JsonFileStoreOptions } from "./json.js";
export { Conversation, createConversation, type ConversationOptions, type MemorySearchOptions } from "./conversation.js";\n