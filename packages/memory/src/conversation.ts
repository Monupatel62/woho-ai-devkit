import type { MemoryMessage, MemoryStore } from "./index.js";

export interface MemorySearchOptions {
  query: string;
  limit?: number;
}

export interface ConversationOptions {
  sessionId: string;
  store: MemoryStore;
  maxMessages?: number;
}

export class Conversation {
  readonly sessionId: string;
  private readonly store: MemoryStore;
  private readonly maxMessages: number;

  constructor(options: ConversationOptions) {
    if (!options.sessionId.trim()) throw new Error("sessionId is required");
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.maxMessages = options.maxMessages ?? 100;
    if (!Number.isInteger(this.maxMessages) || this.maxMessages < 1) throw new Error("maxMessages must be a positive integer");
  }

  async add(message: Omit<MemoryMessage, "metadata"> & { metadata?: Record<string, unknown> }): Promise<void> {
    await this.store.add({
      ...message,
      metadata: { ...(message.metadata ?? {}), sessionId: this.sessionId },
    });
  }

  async messages(limit = this.maxMessages): Promise<MemoryMessage[]> {
    return this.store.list({ limit, sessionId: this.sessionId });
  }

  async search(options: MemorySearchOptions): Promise<MemoryMessage[]> {
    const query = options.query.trim().toLowerCase();
    if (!query) throw new Error("query is required");
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    const items = await this.store.list({ sessionId: this.sessionId });
    return items.filter((item) => item.metadata?.sessionId === this.sessionId && item.content.toLowerCase().includes(query)).slice(-limit);
  }

  async clear(): Promise<void> {
    const items = await this.store.list({ sessionId: this.sessionId });
    if (!items.length) return;
    if (this.store.delete) {
      for (const item of items) await this.store.delete(item.id);
      return;
    }
    const all = await this.store.list();
    if (all.length === items.length) await this.store.clear();
    else throw new Error("Memory store does not support session-scoped deletion");
  }
}

export function createConversation(options: ConversationOptions): Conversation {
  return new Conversation(options);
}
