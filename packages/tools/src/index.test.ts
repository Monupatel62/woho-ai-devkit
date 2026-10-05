import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolPolicy, calculatorTool, jsonTool, textLengthTool, httpGetTool, fileReadTool } from "./index.js";

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
  await rm(root, { recursive: true, force: true });
  console.log("tools runtime tests passed");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
