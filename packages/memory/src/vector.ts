import type { MemoryMessage } from "./index.js";

export interface MemoryEmbedder {
  embed(text: string): Promise<readonly number[]>;
}

export interface SemanticMemoryResult {
  readonly message: MemoryMessage;
  readonly score: number;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aa += av * av;
    bb += bv * bv;
  }
  if (aa === 0 || bb === 0) return 0;
  return dot / Math.sqrt(aa * bb);
}

export async function searchMemorySemantic(
  messages: readonly MemoryMessage[],
  query: string,
  embedder: MemoryEmbedder,
  options: { readonly limit?: number; readonly minScore?: number; readonly maxMessages?: number; readonly maxTextCharacters?: number } = {},
): Promise<SemanticMemoryResult[]> {
  if (!query.trim()) throw new Error("query cannot be empty");
  if (!embedder || typeof embedder.embed !== "function") throw new Error("embedder is required");
  const limit = options.limit ?? 10;
  const minScore = options.minScore ?? -1;
  const maxMessages = options.maxMessages ?? 1000;
  const maxTextCharacters = options.maxTextCharacters ?? 100_000;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (!Number.isFinite(minScore)) throw new Error("minScore must be finite");
  if (!Number.isInteger(maxMessages) || maxMessages < 1) throw new Error("maxMessages must be a positive integer");
  if (!Number.isInteger(maxTextCharacters) || maxTextCharacters < 1) throw new Error("maxTextCharacters must be a positive integer");
  if (messages.length > maxMessages) throw new Error("semantic memory search exceeds maxMessages");
  if (query.length > maxTextCharacters) throw new Error("query exceeds maxTextCharacters");

  const queryVector = await embedder.embed(query);
  const results: SemanticMemoryResult[] = [];
  for (const message of messages) {
    if (message.content.length > maxTextCharacters) throw new Error("memory message exceeds maxTextCharacters");
    const vector = await embedder.embed(message.content);
    const score = cosine(queryVector, vector);
    if (score >= minScore) results.push({ message, score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
