import type { MemoryMessage, MemoryStore } from "./index.js";

export interface MemorySearchResult {
  readonly message: MemoryMessage;
  readonly score: number;
}

export async function searchMemory(store: MemoryStore, query: string, options: { limit?: number; sessionId?: string } = {}): Promise<MemorySearchResult[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error("query is required");
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const messages = await store.list({ sessionId: options.sessionId });
  const terms = needle.split(/\s+/).filter(Boolean);
  return messages.map((message) => {
    const haystack = message.content.toLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    return { message, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
