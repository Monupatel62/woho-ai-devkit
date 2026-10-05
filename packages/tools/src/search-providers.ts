import type { SearchProvider } from "./search.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchProviderOptions {
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function createFetch(fetchImpl: typeof fetch | undefined, timeoutMs: number) {
  if (timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  const fn = fetchImpl ?? fetch;
  return async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    try {
      return await fn(input, { ...init, signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

function requireApiKey(apiKey: string) {
  if (!apiKey.trim()) throw new Error("apiKey is required");
}

function clampLimit(limit: number | undefined, max: number) {
  const value = limit ?? 10;
  if (!Number.isInteger(value) || value < 1) throw new Error("limit must be a positive integer");
  return Math.min(value, max);
}

export function createBraveSearchProvider(options: SearchProviderOptions): SearchProvider {
  requireApiKey(options.apiKey);
  const request = createFetch(options.fetchImpl, options.timeoutMs ?? 10_000);
  return {
    async search(query, searchOptions) {
      if (!query.trim()) throw new Error("query is required");
      const count = clampLimit(searchOptions?.limit, 20);
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));
      const response = await request(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": options.apiKey },
        signal: searchOptions?.signal,
      });
      if (!response.ok) throw new Error(`Brave Search request failed: ${response.status}`);
      const body = await response.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      return (body.web?.results ?? [])
        .filter((item): item is { title: string; url: string; description?: string } => typeof item.title === "string" && typeof item.url === "string")
        .slice(0, count)
        .map((item) => ({ title: item.title, url: item.url, snippet: item.description }));
    },
  };
}

export function createTavilySearchProvider(options: SearchProviderOptions): SearchProvider {
  requireApiKey(options.apiKey);
  const request = createFetch(options.fetchImpl, options.timeoutMs ?? 10_000);
  return {
    async search(query, searchOptions) {
      if (!query.trim()) throw new Error("query is required");
      const maxResults = clampLimit(searchOptions?.limit, 20);
      const response = await request("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: options.apiKey, query, max_results: maxResults }),
        signal: searchOptions?.signal,
      });
      if (!response.ok) throw new Error(`Tavily Search request failed: ${response.status}`);
      const body = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
      return (body.results ?? [])
        .filter((item): item is { title: string; url: string; content?: string } => typeof item.title === "string" && typeof item.url === "string")
        .slice(0, maxResults)
        .map((item) => ({ title: item.title, url: item.url, snippet: item.content }));
    },
  };
}
