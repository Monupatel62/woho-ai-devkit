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
  assert.throws(() => server.registerTool({ definition: { name: " echo " }, execute: async () => null }), /surrounding whitespace/);
  await assert.rejects(() => server.callTool("missing", {}), /Unknown/);

  let timedOutToolAborted = false;
  const boundedServer = createMCPServer({
    name: "bounded-server",
    version: "1.0.0",
    maxExecutionMs: 5,
    maxResultBytes: 20,
    tools: [
      { definition: { name: "slow" }, execute: async (_input, signal) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        timedOutToolAborted = signal?.aborted === true;
        return "late";
      } },
      { definition: { name: "large" }, execute: async () => "x".repeat(100) },
    ],
    resources: [{ definition: { uri: "memory://large" }, read: async () => [{ uri: "memory://large", text: "x".repeat(100) }] }],
    prompts: [{ definition: { name: "slow" }, get: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return "late"; } }],
  });
  await assert.rejects(() => boundedServer.callTool("slow", {}), /execution timed out/);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(timedOutToolAborted, true);
  await assert.rejects(() => boundedServer.callTool("large", {}), /result exceeds maxResultBytes/);
  await assert.rejects(() => boundedServer.readResource("memory://large"), /result exceeds maxResultBytes/);
  await assert.rejects(() => boundedServer.getPrompt("slow"), /execution timed out/);
  assert.throws(() => createMCPServer({ name: "bad", version: "1", maxExecutionMs: 0 }), /maxExecutionMs/);
  assert.throws(() => createMCPServer({ name: "bad", version: "1", maxResultBytes: 0 }), /maxResultBytes/);

  const secretServer = createMCPServer({
    name: "secret-server",
    version: "1.0.0",
    tools: [{ definition: { name: "fail-tool" }, execute: async () => { throw new Error("secret tool credential"); } }],
    resources: [{ definition: { uri: "secret://resource" }, read: async () => { throw new Error("secret resource credential"); } }],
    prompts: [{ definition: { name: "fail-prompt" }, get: async () => { throw new Error("secret prompt credential"); } }],
  });
  await assert.rejects(
    () => secretServer.callTool("fail-tool", {}),
    (error) => error instanceof Error && error.message === "MCP tool execution failed" && !error.message.includes("secret tool credential"),
  );
  await assert.rejects(
    () => secretServer.readResource("secret://resource"),
    (error) => error instanceof Error && error.message === "MCP resource read failed" && !error.message.includes("secret resource credential"),
  );
  await assert.rejects(
    () => secretServer.getPrompt("fail-prompt"),
    (error) => error instanceof Error && error.message === "MCP prompt execution failed" && !error.message.includes("secret prompt credential"),
  );

  assert.throws(() => createMCPClient({ transport, clientName: " " }), /clientName is required/);
  assert.throws(() => createMCPClient({ transport, clientVersion: " " }), /clientVersion is required/);
  assert.throws(() => createMCPClient({ transport, protocolVersion: " " }), /protocolVersion is required/);
  await assert.rejects(() => createMCPClient({ transport }).getPrompt(" greet "), /surrounding whitespace/);
  await assert.rejects(() => createMCPClient({ transport }).callTool(" echo "), /surrounding whitespace/);

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

  const toolRestricted = createMCPClient({ transport, security: { allowedToolNames: ["missing"] } });
  await assert.rejects(() => toolRestricted.callTool("echo", {}), /not allowed/);
  await toolRestricted.close();
  const schemeRestricted = createMCPClient({ transport, security: { allowedResourceSchemes: ["https"] } });
  await assert.rejects(() => schemeRestricted.readResource("memory://hello"), /scheme is not allowed/);
  await schemeRestricted.close();
  const restricted = createMCPClient({ transport, security: { allowedMethods: ["initialize"] } });
  await assert.rejects(() => restricted.listTools(), /not allowed/);
  await restricted.close();
  await assert.rejects(() => restricted.listTools(), /client is closed/);
  await client.close();
  await assert.rejects(() => client.listTools(), /client is closed/);

  const secretTransport: MCPTransport = {
    async request() { throw new Error("secret custom transport credential"); },
  };
  const secretClient = createMCPClient({ transport: secretTransport });
  await assert.rejects(
    () => secretClient.listTools(),
    (error) => error instanceof Error && error.message === "MCP transport request failed" && !error.message.includes("secret custom transport credential"),
  );
  await secretClient.close();

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

  process.env.WOHO_MCP_STDIO_SECRET = "parent-secret";
  const isolatedEnvScript = 'process.stdin.setEncoding("utf8"); process.stdin.on("data",()=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{secret:process.env.WOHO_MCP_STDIO_SECRET ?? null, custom:process.env.WOHO_MCP_CUSTOM ?? null}})+"\\n"));';
  const isolatedStdio = createMCPStdioTransport({ command: execPath, args: ["-e", isolatedEnvScript], env: { WOHO_MCP_CUSTOM: "custom-value" }, timeoutMs: 1000 });
  assert.deepEqual(await isolatedStdio.request("ping"), { secret: null, custom: "custom-value" });
  await isolatedStdio.close();
  const inheritedStdio = createMCPStdioTransport({ command: execPath, args: ["-e", isolatedEnvScript], inheritEnvironment: true, timeoutMs: 1000 });
  assert.deepEqual(await inheritedStdio.request("ping"), { secret: "parent-secret", custom: null });
  await inheritedStdio.close();
  delete process.env.WOHO_MCP_STDIO_SECRET;

  const secretCircular: Record<string, unknown> = {};
  secretCircular.self = secretCircular;
  const circularStdio = createMCPStdioTransport({ command: execPath, args: ["-e", "process.stdin.resume();"], timeoutMs: 1000 });
  await assert.rejects(
    () => circularStdio.request("ping", secretCircular),
    (error) => error instanceof Error && error.message === "MCP request is not serializable" && !error.message.includes("secret"),
  );
  await circularStdio.close();

  const secretNotifyCircular: Record<string, unknown> = {};
  secretNotifyCircular.self = secretNotifyCircular;
  const notifyCircularStdio = createMCPStdioTransport({ command: execPath, args: ["-e", "process.stdin.resume();"], timeoutMs: 1000 });
  await assert.rejects(
    () => notifyCircularStdio.notify("secret-notify", secretNotifyCircular),
    (error) => error instanceof Error && error.message === "MCP notification is not serializable" && !error.message.includes("secret"),
  );
  await notifyCircularStdio.close();

  const malformedStdioScript = 'process.stdin.setEncoding("utf8"); process.stdin.on("data",()=>process.stdout.write(JSON.stringify({jsonrpc:"1.0",id:1,result:{ok:true}})+"\\n"));';
  const malformedStdio = createMCPStdioTransport({ command: execPath, args: ["-e", malformedStdioScript], timeoutMs: 1000 });
  await assert.rejects(() => malformedStdio.request("ping"), /Invalid MCP JSON-RPC response/);
  await malformedStdio.close();

  const errorStdioScript = 'process.stdin.setEncoding("utf8"); process.stdin.on("data",()=>process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,error:{code:-32000,message:"secret server token"}})+"\\n"));';
  const errorStdio = createMCPStdioTransport({ command: execPath, args: ["-e", errorStdioScript], timeoutMs: 1000 });
  await assert.rejects(() => errorStdio.request("ping"), (error) => error instanceof Error && error.message === "MCP JSON-RPC request failed" && !error.message.includes("secret server token"));
  await errorStdio.close();

  const oversizedStdioScript = 'process.stdin.resume(); process.stdout.write("x".repeat(200));';
  const oversizedStdio = createMCPStdioTransport({ command: execPath, args: ["-e", oversizedStdioScript], timeoutMs: 1000, maxMessageBytes: 50 });
  await assert.rejects(() => oversizedStdio.request("ping"), /exceeds maxMessageBytes/);
  await oversizedStdio.close();

  const slowStdioScript = 'process.stdin.resume();';
  const slowStdio = createMCPStdioTransport({ command: execPath, args: ["-e", slowStdioScript], timeoutMs: 10 });
  await assert.rejects(() => slowStdio.request("ping"), /timed out/);
  await slowStdio.close();

  console.log("mcp runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
