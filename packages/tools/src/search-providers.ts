import type { SearchProvider } from "./search.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface SearchProviderOptions {
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {\n  if (!response.body) throw new Error("Search provider returned no response body");\n  const reader = response.body.getReader();\n  const decoder = new TextDecoder();\n  const chunks: string[] = [];\n  let received = 0;\n  try {\n    while (true) {\n      const { value, done } = await reader.read();\n      if (done) break;\n      received += value.byteLength;\n      if (received > maxBytes) throw new Error("Search provider response exceeds size limit");\n      chunks.push(decoder.decode(value, { stream: true }));\n    }\n    chunks.push(decoder.decode());\n    return chunks.join("");\n  } finally {\n    await reader.cancel().catch(() => undefined);\n  }\n}\n\nfunction createFetch(fetchImpl: typeof fetch | undefined, timeoutMs: number, maxResponseBytes: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error("maxResponseBytes must be a positive integer");
  const fn = fetchImpl ?? fetch;
  return async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    try {
      const response = await fn(input, { ...init, signal });
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > maxResponseBytes) throw new Error("Search provider response exceeds size limit");
      return { response, maxResponseBytes };
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
  const request = createFetch(options.fetchImpl, options.timeoutMs ?? 10_000, options.maxResponseBytes ?? 2_000_000);
  return {
    async search(query, searchOptions) {
      if (!query.trim()) throw new Error("query is required");
      const count = clampLimit(searchOptions?.limit, 20);
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(count));
      const { response, maxResponseBytes } = await request(url, {
        headers: { Accept: "application/json", "X-Subscription-Token": options.apiKey },
        signal: searchOptions?.signal,
      });
      if (!response.ok) throw new Error(`Brave Search request failed: ${response.status}`);
      const body = JSON.parse(await readBodyWithLimit(response, maxResponseBytes)) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      return (body.web?.results ?? [])
        .filter((item): item is { title: string; url: string; description?: string } => typeof item.title === "string" && typeof item.url === "string")
        .slice(0, count)
        .map((item) => ({ title: item.title, url: item.url, snippet: item.description }));
    },
  };
}

export function createTavilySearchProvider(options: SearchProviderOptions): SearchProvider {
  requireApiKey(options.apiKey);
  const request = createFetch(options.fetchImpl, options.timeoutMs ?? 10_000, options.maxResponseBytes ?? 2_000_000);
  return {
    async search(query, searchOptions) {
      if (!query.trim()) throw new Error("query is required");
      const maxResults = clampLimit(searchOptions?.limit, 20);
      const { response, maxResponseBytes } = await request("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: options.apiKey, query, max_results: maxResults }),
        signal: searchOptions?.signal,
      });
      if (!response.ok) throw new Error(`Tavily Search request failed: ${response.status}`);
      const body = JSON.parse(await readBodyWithLimit(response, maxResponseBytes)) as { results?: Array<{ title?: string; url?: string; content?: string }> };
      return (body.results ?? [])
        .filter((item): item is { title: string; url: string; content?: string } => typeof item.title === "string" && typeof item.url === "string")
        .slice(0, maxResults)
        .map((item) => ({ title: item.title, url: item.url, snippet: item.content }));
    },
  };
}
