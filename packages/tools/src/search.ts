import type { AgentTool } from "@woho/agents";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchProvider {
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult[]>;
}

export interface SearchToolPolicy {
  provider: SearchProvider;
  maxQueryLength?: number;
  maxResults?: number;
}

export function searchTool(policy: SearchToolPolicy): AgentTool {
  const maxQueryLength = policy.maxQueryLength ?? 500;
  const maxResults = policy.maxResults ?? 10;
  if (maxQueryLength <= 0 || maxResults <= 0) throw new Error("Search limits must be positive");

  return {
    name: "search",
    description: "Search the configured search provider. The application controls which provider is used.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const value = input as { query?: unknown; limit?: unknown };
      if (typeof value.query !== "string" || !value.query.trim()) throw new Error("query is required");
      if (value.query.length > maxQueryLength) throw new Error("Query exceeds size limit");

      const requested = value.limit === undefined ? maxResults : Number(value.limit);
      if (!Number.isInteger(requested) || requested < 1) throw new Error("limit must be a positive integer");
      const limit = Math.min(requested, maxResults);
      const results = await policy.provider.search(value.query.trim(), { limit });
      return results.slice(0, limit);
    },
  };
}

export function createSearchProvider(
  search: (query: string, options?: { limit?: number; signal?: AbortSignal }) => Promise<SearchResult[]>,
): SearchProvider {
  return { search };
}
