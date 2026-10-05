import assert from "node:assert/strict";
import { createToolPolicy, calculatorTool, jsonTool, textLengthTool, httpGetTool, fileReadTool, createSearchProvider, searchTool } from "./index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = async () => {
  assert.deepEqual(await calculatorTool().execute({ expression: "6 * 7" }), { expression: "6 * 7", result: 42 });
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

  await rm(root, { recursive: true, force: true });
  console.log("tools runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
