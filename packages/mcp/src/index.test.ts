import assert from "node:assert/strict";
import { createMCPServer } from "./index.js";

const run = async () => {
  const server = createMCPServer({
    name: "test-server",
    version: "0.1.0",
    tools: [{ definition: { name: "echo" }, execute: async (input) => input }],
  });
  assert.deepEqual(server.listTools(), [{ name: "echo" }]);
  assert.deepEqual(await server.callTool("echo", { ok: true }), { ok: true });
  assert.throws(() => server.registerTool({ definition: { name: "echo" }, execute: async () => null }), /Duplicate/);
  await assert.rejects(() => server.callTool("missing", {}), /Unknown/);
  console.log("mcp runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
