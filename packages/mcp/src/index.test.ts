import assert from "node:assert/strict";
import { createMCPClient, createMCPServer, type MCPTransport } from "./index.js";

const server = createMCPServer({
  name: "test-server",
  version: "0.1.0",
  tools: [{ definition: { name: "echo" }, execute: async (input) => input }],
});

const transport: MCPTransport = {
  async request(method, params, signal) {
    if (signal?.aborted) throw new Error("aborted");
    if (method === "initialize") return { serverInfo: server.info, capabilities: { tools: {} } };
    if (method === "tools/list") return { tools: server.listTools() };
    if (method === "tools/call") {
      const value = params as { name: string; arguments: unknown };
      const result = await server.callTool(value.name, value.arguments);
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
    }
    throw new Error("Unknown method: " + method);
  },
  async notify(method) {
    assert.equal(method, "notifications/initialized");
  },
};

const run = async () => {
  assert.deepEqual(server.listTools(), [{ name: "echo" }]);
  assert.deepEqual(await server.callTool("echo", { ok: true }), { ok: true });
  assert.throws(() => server.registerTool({ definition: { name: "echo" }, execute: async () => null }), /Duplicate/);
  await assert.rejects(() => server.callTool("missing", {}), /Unknown/);

  const client = createMCPClient({ transport, timeoutMs: 1000 });
  const tools = await client.listTools();
  assert.deepEqual(tools, [{ name: "echo" }]);
  const result = await client.callTool("echo", { ok: true });
  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, "text");
  await client.close();

  console.log("mcp runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
