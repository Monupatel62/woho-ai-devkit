import assert from "node:assert/strict";
import { createMCPClient, createMCPServer, createMCPStdioTransport, type MCPTransport } from "./index.js";
import { execPath } from "node:process";

const server = createMCPServer({
  name: "test-server",
  version: "0.1.0",
  tools: [{ definition: { name: "echo" }, execute: async (input) => input }],
  resources: [{ definition: { uri: "memory://hello", name: "hello" }, read: async () => [{ uri: "memory://hello", text: "hello" }] }],
  prompts: [{ definition: { name: "greet" }, get: async (args) => ({ text: "Hello " + (args?.name ?? "world") }) }],
});

const transport: MCPTransport = {
  async request(method, params, signal) {
    if (signal?.aborted) throw new Error("aborted");
    if (method === "initialize") return { serverInfo: server.info, capabilities: { tools: {} } };
    if (method === "tools/list") return { tools: server.listTools() };
    if (method === "resources/list") return { resources: server.listResources() };
    if (method === "resources/read") return { contents: await server.readResource((params as { uri: string }).uri) };
    if (method === "prompts/list") return { prompts: server.listPrompts() };
    if (method === "prompts/get") {
      const value = params as { name: string; arguments?: Record<string, string> };
      return server.getPrompt(value.name, value.arguments);
    }
    if (method === "tools/call") {
      const value = params as { name: string; arguments: unknown };
      const result = await server.callTool(value.name, value.arguments);
      return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
    }
    throw new Error("Unknown method: " + method);
  },
  async notify(method) { assert.equal(method, "notifications/initialized"); },
};

const run = async () => {
  assert.deepEqual(server.listTools(), [{ name: "echo" }]);
  assert.deepEqual(await server.callTool("echo", { ok: true }), { ok: true });
  assert.throws(() => server.registerTool({ definition: { name: "echo" }, execute: async () => null }), /Duplicate/);
  await assert.rejects(() => server.callTool("missing", {}), /Unknown/);

  const client = createMCPClient({
    transport,
    timeoutMs: 1000,
    security: {
      maxResponseBytes: 10000,
      allowedMethods: ["initialize", "tools/list", "tools/call", "resources/list", "resources/read", "prompts/list", "prompts/get"],
    },
  });
  const resources = await client.listResources();
  assert.equal(resources[0].uri, "memory://hello");
  assert.deepEqual(await client.readResource("memory://hello"), [{ uri: "memory://hello", text: "hello" }]);
  const prompts = await client.listPrompts();
  assert.equal(prompts[0].name, "greet");
  assert.deepEqual(await client.getPrompt("greet", { name: "Monu" }), { text: "Hello Monu" });
  const tools = await client.listTools();
  assert.deepEqual(tools, [{ name: "echo" }]);
  const result = await client.callTool("echo", { ok: true });
  assert.equal(result.isError, false);
  assert.equal((result.content as Array<{ type: string }>)[0].type, "text");

  const restricted = createMCPClient({ transport, security: { allowedMethods: ["initialize"] } });
  await assert.rejects(() => restricted.listTools(), /not allowed/);
  await restricted.close();
  await assert.rejects(() => restricted.listTools(), /client is closed/);
  await client.close();
  await assert.rejects(() => client.listTools(), /client is closed/);

  const slowTransport: MCPTransport = {
    async request() { await new Promise((resolve) => setTimeout(resolve, 30)); return { ok: true }; },
  };
  const slowClient = createMCPClient({ transport: slowTransport, timeoutMs: 5 });
  await assert.rejects(() => slowClient.listTools(), /timed out/);
  await slowClient.close();

  const oversizedTransport: MCPTransport = {
    async request(method) {
      if (method === "initialize") return {};
      return { data: "x".repeat(100) };
    },
  };
  const oversizedClient = createMCPClient({ transport: oversizedTransport, security: { maxResponseBytes: 20 } });
  await assert.rejects(() => oversizedClient.listTools(), /maxResponseBytes/);
  await oversizedClient.close();

  const unserializableTransport: MCPTransport = {
    async request(method) {
      if (method === "initialize") return {};
      return { value: BigInt(1) };
    },
  };
  const unserializableClient = createMCPClient({ transport: unserializableTransport });
  await assert.rejects(() => unserializableClient.listTools(), /not serializable/);
  await unserializableClient.close();
  const script = 'process.stdin.setEncoding("utf8"); let b=""; process.stdin.on("data",c=>{b+=c; const lines=b.split("\\n"); b=lines.pop()??""; for(const line of lines){if(!line.trim())continue; const m=JSON.parse(line); process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{ok:true}})+"\\n");}});';
  const stdio = createMCPStdioTransport({ command: execPath, args: ["-e", script], timeoutMs: 1000 });
  assert.deepEqual(await stdio.request("ping"), { ok: true });
  await stdio.close();

  const slowStdioScript = 'process.stdin.resume();';
  const slowStdio = createMCPStdioTransport({ command: execPath, args: ["-e", slowStdioScript], timeoutMs: 10 });
  await assert.rejects(() => slowStdio.request("ping"), /timed out/);
  await slowStdio.close();

  console.log("mcp runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
