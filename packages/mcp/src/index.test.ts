import assert from "node:assert/strict";
import { createMCPClient, createMCPServer, type MCPTransport } from "./index.js";

const server = createMCPServer({
  name: "test-server",
  version: "0.1.0",
  tools: [{ definition: { name: "echo" }, execute: async (input) => input }],\n    resources: [{ definition: { uri: "memory://hello", name: "hello" }, read: async () => [{ uri: "memory://hello", text: "hello" }] }],\n    prompts: [{ definition: { name: "greet" }, get: async (args) => ({ text: "Hello " + (args?.name ?? "world") }) }],
});

const transport: MCPTransport = {
  async request(method, params, signal) {
    if (signal?.aborted) throw new Error("aborted");
    if (method === "initialize") return { serverInfo: server.info, capabilities: { tools: {} } };
    if (method === "tools/list") return { tools: server.listTools() };\n    if (method === "resources/list") return { resources: server.listResources() };\n    if (method === "resources/read") return { contents: await server.readResource((params as { uri: string }).uri) };\n    if (method === "prompts/list") return { prompts: server.listPrompts() };\n    if (method === "prompts/get") { const value = params as { name: string; arguments?: Record<string, string> }; return await server.getPrompt(value.name, value.arguments); }
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
  const resources = await client.listResources();\n  assert.equal(resources[0].uri, "memory://hello");\n  assert.deepEqual(await client.readResource("memory://hello"), [{ uri: "memory://hello", text: "hello" }]);\n  const prompts = await client.listPrompts();\n  assert.equal(prompts[0].name, "greet");\n  assert.deepEqual(await client.getPrompt("greet", { name: "Monu" }), { text: "Hello Monu" });\n\n  const tools = await client.listTools();
  assert.deepEqual(tools, [{ name: "echo" }]);
  const result = await client.callTool("echo", { ok: true });
  assert.equal(result.isError, false);
  assert.equal(result.content[0].type, "text");
  await client.close();

  console.log("mcp runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
