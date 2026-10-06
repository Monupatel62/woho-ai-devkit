import type { MemoryMessage, MemoryStore } from "./index.js";

export interface MemorySearchResult {
  readonly message: MemoryMessage;
  readonly score: number;
}

export async function searchMemory(store: MemoryStore, query: string, options: { limit?: number; sessionId?: string; maxMessages?: number; maxQueryCharacters?: number; maxTextCharacters?: number } = {}): Promise<MemorySearchResult[]> {
  const maxMessages = options.maxMessages ?? 1000;
  const maxQueryCharacters = options.maxQueryCharacters ?? 10_000;
  const maxTextCharacters = options.maxTextCharacters ?? 100_000;
  if (!Number.isInteger(maxMessages) || maxMessages < 1) throw new Error("maxMessages must be a positive integer");
  if (!Number.isInteger(maxQueryCharacters) || maxQueryCharacters < 1) throw new Error("maxQueryCharacters must be a positive integer");
  if (!Number.isInteger(maxTextCharacters) || maxTextCharacters < 1) throw new Error("maxTextCharacters must be a positive integer");
  const needle = query.trim().toLowerCase();
  if (needle.length > maxQueryCharacters) throw new Error("query exceeds maxQueryCharacters");
  if (!needle) throw new Error("query is required");
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const messages = (await store.list({ sessionId: options.sessionId, limit: maxMessages })).slice(-maxMessages);
  const terms = needle.split(/\s+/).filter(Boolean);
  return messages.map((message) => {
    const haystack = message.content.slice(0, maxTextCharacters).toLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    return { message, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}
