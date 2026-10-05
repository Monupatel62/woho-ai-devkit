import assert from "node:assert/strict";
import { createToolPolicy, calculatorTool, jsonTool, textLengthTool, httpGetTool, fileReadTool, createSearchProvider, searchTool, createBraveSearchProvider, createTavilySearchProvider, createToolRegistry, validateToolInput } from "./index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = async () => {
  assert.deepEqual(await calculatorTool().execute({ expression: "6 * 7" }), { expression: "6 * 7", result: 42 });
  validateToolInput({ type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false }, { x: 1 });
  assert.throws(() => validateToolInput({ type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false }, { x: "1" }), /Invalid type/);
  assert.throws(() => validateToolInput({ type: "object", properties: { x: { type: "number" } }, additionalProperties: false }, { y: 1 }), /Unknown parameter/);
  const registry = createToolRegistry([calculatorTool()]);
  assert.equal(registry.has("calculator"), true);
  assert.equal(registry.list().length, 1);
  assert.throws(() => registry.register(calculatorTool()), /Duplicate tool/);
  assert.deepEqual(await jsonTool().execute({ text: '{"ok":true}' }), { ok: true });
  assert.deepEqual(await textLengthTool().execute({ text: "hello" }), { length: 5 });

  assert.throws(() => createToolPolicy({ timeoutMs: 0 }), /positive/);
  await assert.rejects(() => httpGetTool().execute({ url: "https://example.com" }), /not allowed/);
  await assert.rejects(() => httpGetTool().execute({ url: "http://example.com" }), /HTTPS/);

  const policy = createToolPolicy({ allowedHosts: ["example.com"] });
  assert.equal(policy.timeoutMs, 10_000);

  const root = await mkdtemp(join(tmpdir(), "woho-tools-"));
  const safeFile = join(root, "safe.txt");
  await writeFile(safeFile, "hello", "utf8");
  assert.deepEqual(await fileReadTool({ allowedDirectories: [root] }).execute({ path: safeFile }), { path: safeFile, text: "hello" });
  await assert.rejects(() => fileReadTool().execute({ path: safeFile }), /No allowed directories/);

  const provider = createSearchProvider(async (query, options) => [
    { title: query, url: "https://example.com/1", snippet: "one" },
    { title: "two", url: "https://example.com/2" },
  ].slice(0, options?.limit ?? 10));
  const results = await searchTool({ provider, maxResults: 2 }).execute({ query: "woho", limit: 1 });
  assert.deepEqual(results, [{ title: "woho", url: "https://example.com/1", snippet: "one" }]);
  await assert.rejects(() => searchTool({ provider }).execute({ query: "" }), /query is required/);
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.ok(init?.headers);
    if (url.includes("brave")) {
      return new Response(JSON.stringify({ web: { results: [{ title: "Brave result", url: "https://example.com", description: "snippet" }] } }), { status: 200 });
    }
    assert.equal(url, "https://api.tavily.com/search");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.query, "woho");
    return new Response(JSON.stringify({ results: [{ title: "Tavily result", url: "https://example.org", content: "content" }] }), { status: 200 });
  };
  const brave = createBraveSearchProvider({ apiKey: "test", fetchImpl: mockFetch });
  assert.deepEqual(await brave.search("woho", { limit: 1 }), [{ title: "Brave result", url: "https://example.com", snippet: "snippet" }]);
  const tavily = createTavilySearchProvider({ apiKey: "test", fetchImpl: mockFetch });
  assert.deepEqual(await tavily.search("woho", { limit: 1 }), [{ title: "Tavily result", url: "https://example.org", snippet: "content" }]);
  assert.throws(() => createBraveSearchProvider({ apiKey: " " }), /apiKey is required/);

  await rm(root, { recursive: true, force: true });
  console.log("tools runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
