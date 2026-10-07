import assert from "node:assert/strict";
import { createToolPolicy, calculatorTool, jsonTool, textLengthTool, httpGetTool, fileReadTool, createSearchProvider, searchTool, createBraveSearchProvider, createTavilySearchProvider, createToolRegistry, validateToolInput } from "./index.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandTool } from "./command.js";
import { resolvePublicHttpsAddress } from "./index.js";

const run = async () => {
  assert.deepEqual(await calculatorTool().execute({ expression: "6 * 7" }), { expression: "6 * 7", result: 42 });
  assert.deepEqual(await calculatorTool().execute({ expression: "(2 + 3) * 4 - 6 / 2" }), { expression: "(2 + 3) * 4 - 6 / 2", result: 17 });
  assert.deepEqual(await calculatorTool().execute({ expression: "10 % 3" }), { expression: "10 % 3", result: 1 });
  assert.deepEqual(await calculatorTool().execute({ expression: "-5 + 2" }), { expression: "-5 + 2", result: -3 });
  assert.deepEqual(await calculatorTool().execute({ expression: "(-5 + 2) * 3" }), { expression: "(-5 + 2) * 3", result: -9 });
  await assert.rejects(() => calculatorTool().execute({ expression: "1 / 0" }), /finite number/);
  await assert.rejects(() => calculatorTool().execute({ expression: "1 + process.exit()" }), /Only basic arithmetic is allowed/);
  validateToolInput({ type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false }, { x: 1 });
  assert.throws(() => validateToolInput({ type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false }, { x: "1" }), /Invalid type/);
  assert.throws(() => validateToolInput({ type: "object", properties: { x: { type: "number" } }, additionalProperties: false }, { y: 1 }), /Unknown parameter/);
  const registry = createToolRegistry([calculatorTool()]);
  assert.equal(registry.has("calculator"), true);
  assert.equal(registry.list().length, 1);
  assert.throws(() => registry.register(calculatorTool()), /Duplicate tool/);
  assert.deepEqual(await jsonTool().execute({ text: '{"ok":true}' }), { ok: true });
  assert.deepEqual(await textLengthTool().execute({ text: "hello" }), { length: 5 });

  assert.throws(() => createToolPolicy({ timeoutMs: 0 }), /positive integer/);
  assert.throws(() => createToolPolicy({ timeoutMs: 1.5 }), /positive integer/);
  assert.throws(() => createToolPolicy({ maxResponseBytes: -1 }), /positive integer/);
  assert.throws(() => createToolPolicy({ allowedHosts: [""] }), /non-empty strings/);
  assert.throws(() => createToolPolicy({ allowedDirectories: [""] }), /non-empty strings/);
  assert.deepEqual(createToolPolicy({ allowedHosts: ["Example.COM."] }).allowedHosts, ["example.com"]);
  assert.equal(createToolPolicy().allowPrivateAddresses, false);
  await assert.rejects(() => resolvePublicHttpsAddress("127.0.0.1", false), /private or reserved/);
  const pinnedLoopback = await resolvePublicHttpsAddress("127.0.0.1", true);
  assert.deepEqual(pinnedLoopback, { address: "127.0.0.1", family: 4 });
  assert.throws(() => createToolPolicy({ allowPrivateAddresses: "yes" as never }), /boolean/);
  const unixPathPolicy = createToolPolicy({ allowedDirectories: ["/Tmp/WoHo"] });
  assert.deepEqual(unixPathPolicy.allowedDirectories, ["/Tmp/WoHo"]);
  await assert.rejects(() => httpGetTool().execute({ url: "https://example.com" }), /not allowed/);
  await assert.rejects(() => httpGetTool({ allowedHosts: ["127.0.0.1"] }).execute({ url: "https://127.0.0.1" }), /private or reserved/);
  await assert.rejects(() => httpGetTool({ allowedHosts: ["127.0.0.1"] }).execute({ url: "https://127.0.0.1", }), /private or reserved/);
  for (const address of ["192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1"]) {
    await assert.rejects(() => httpGetTool({ allowedHosts: [address] }).execute({ url: "https://" + address }), /private or reserved/);
  }
  await assert.rejects(() => httpGetTool().execute({ url: "http://example.com" }), /HTTPS/);

  const normalizedPolicy = createToolPolicy({ allowedHosts: ["Example.COM."] });
  assert.deepEqual(normalizedPolicy.allowedHosts, ["example.com"]);
  const policy = createToolPolicy({ allowedHosts: ["example.com"] });
  assert.equal(policy.timeoutMs, 10_000);
  await assert.rejects(() => httpGetTool({ allowedHosts: ["example.com"], maxResponseBytes: 1 }).execute({ url: "https://example.com" }), /size limit|Response/);
  await assert.rejects(() => httpGetTool({ allowedHosts: ["example.com"] }).execute({ url: "https://user:pass@example.com" }), /Credential-bearing/);

  const root = await mkdtemp(join(tmpdir(), "woho-tools-"));
  const safeFile = join(root, "safe.txt");
  await writeFile(safeFile, "hello", "utf8");
  assert.deepEqual(await fileReadTool({ allowedDirectories: [root] }).execute({ path: safeFile }), { path: safeFile, text: "hello" });
  await assert.rejects(() => fileReadTool().execute({ path: safeFile }), /No allowed directories/);

  const provider = createSearchProvider(async (query, options) => [
    { title: query, url: "https://example.com/1", snippet: "one" },
    { title: "two", url: "https://example.com/2" },
  ].slice(0, options?.limit ?? 10));
  assert.throws(() => searchTool({ provider, maxResults: 1.5 }), /positive integers/);
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
  assert.throws(() => createBraveSearchProvider({ apiKey: "test", timeoutMs: 1.5 }), /positive integer/);
  const brave = createBraveSearchProvider({ apiKey: "test", fetchImpl: mockFetch });
  assert.deepEqual(await brave.search("woho", { limit: 1 }), [{ title: "Brave result", url: "https://example.com", snippet: "snippet" }]);
  const tavily = createTavilySearchProvider({ apiKey: "test", fetchImpl: mockFetch });
  assert.deepEqual(await tavily.search("woho", { limit: 1 }), [{ title: "Tavily result", url: "https://example.org", snippet: "content" }]);
  const oversizedFetch: typeof fetch = async () => new Response("x".repeat(100));
  const boundedBrave = createBraveSearchProvider({ apiKey: "test", maxResponseBytes: 10, fetchImpl: oversizedFetch });
  await assert.rejects(() => boundedBrave.search("woho"), /size limit/);
  const boundedTavily = createTavilySearchProvider({ apiKey: "test", maxResponseBytes: 10, fetchImpl: oversizedFetch });
  await assert.rejects(() => boundedTavily.search("woho"), /size limit/);

  const hangingBodyFetch: typeof fetch = async (_input, init) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  };
  const timedSearch = createBraveSearchProvider({ apiKey: "test", timeoutMs: 10, fetchImpl: hangingBodyFetch });
  await assert.rejects(() => timedSearch.search("woho"), /timed out|aborted/);
  assert.throws(() => createBraveSearchProvider({ apiKey: " " }), /apiKey is required/);

  const command = commandTool({ allowedCommands: ["node"], allowedDirectories: [process.cwd()], timeoutMs: 2_000, maxOutputBytes: 10_000 });
  assert.equal(command.capability, "command");
  assert.equal(command.action, "execute");
  assert.deepEqual(command.authorize?.({ command: process.execPath, cwd: process.cwd() }), {
    capability: "command",
    action: "execute",
    resource: `command:${process.execPath.split(/[\\\\/]/).pop()?.toLowerCase()}@${process.cwd()}`,
  });
  assert.deepEqual(command.authorize?.({ command: process.execPath }), {
    capability: "command",
    action: "execute",
    resource: `command:${process.execPath.split(/[\\\\/]/).pop()?.toLowerCase()}`,
  });
  const commandResult = await command.execute({ command: process.execPath, args: ["-e", "process.stdout.write('woho-command-ok')"], cwd: process.cwd() }) as { stdout: string };

  const previousSecret = process.env.WOHO_TOOLS_TEST_SECRET;
  process.env.WOHO_TOOLS_TEST_SECRET = "secret-value";
  const isolatedCommand = commandTool({
    allowedCommands: ["node"],
    allowedDirectories: [process.cwd()],
    environment: { WOHO_TOOLS_SAFE: "yes" },
  });
  const isolatedResult = await isolatedCommand.execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write((process.env.WOHO_TOOLS_TEST_SECRET ?? 'missing') + ':' + (process.env.WOHO_TOOLS_SAFE ?? 'missing'))"],
    cwd: process.cwd(),
  }) as { stdout: string };
  assert.equal(isolatedResult.stdout, "missing:yes");
  assert.equal(process.env.WOHO_TOOLS_TEST_SECRET, "secret-value");

  const inheritedCommand = commandTool({
    allowedCommands: ["node"],
    allowedDirectories: [process.cwd()],
    inheritEnvironment: true,
    environment: { WOHO_TOOLS_TEST_SECRET: "explicit-value" },
  });
  const inheritedResult = await inheritedCommand.execute({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.WOHO_TOOLS_TEST_SECRET ?? 'missing')"],
    cwd: process.cwd(),
  }) as { stdout: string };
  assert.equal(inheritedResult.stdout, "explicit-value");
  if (previousSecret === undefined) delete process.env.WOHO_TOOLS_TEST_SECRET; else process.env.WOHO_TOOLS_TEST_SECRET = previousSecret;
  assert.equal(commandResult.stdout, "woho-command-ok");
  await assert.rejects(() => command.execute({ command: "sh", args: ["-c", "echo no"] }), /not allowed/);

  const boundedCommand = commandTool({ allowedCommands: ["node"], allowedDirectories: [process.cwd()], maxArgs: 2, maxArgBytes: 10 });
  await assert.rejects(() => boundedCommand.execute({ command: "node", args: ["-e", "123", "extra"], cwd: process.cwd() }), /maxArgs/);
  await assert.rejects(() => boundedCommand.execute({ command: "node", args: ["-e", "x".repeat(11)], cwd: process.cwd() }), /maxArgBytes/);

  const untrusted = commandTool({ allowedCommands: ["node"], allowedDirectories: [process.cwd()] });
  await assert.rejects(() => untrusted.execute({ command: "node", args: ["-e", "console.log('x')"] }), /cwd is required/);
  await rm(root, { recursive: true, force: true });

  const workspaceRoot = await mkdtemp(join(tmpdir(), "woho-workspace-"));
  const workspace = (await import("./workspace.js")).workspaceTool({ root: workspaceRoot, allowWrite: true, allowDelete: true, allowMove: true, maxFileBytes: 10_000 });
  assert.deepEqual(workspace.authorize?.({ operation: "read", path: "src/hello.txt" }), { capability: "file", action: "read", resource: "src/hello.txt" });
  assert.deepEqual(workspace.authorize?.({ operation: "write", path: "src/hello.txt" }), { capability: "file", action: "write", resource: "src/hello.txt" });
  assert.deepEqual(await workspace.execute({ operation: "write", path: "src/hello.txt", content: "hello" }), { path: "src/hello.txt", bytes: 5 });
  assert.deepEqual(await workspace.execute({ operation: "read", path: "src/hello.txt" }), { path: "src/hello.txt", content: "hello" });
  assert.deepEqual(await workspace.execute({ operation: "edit", path: "src/hello.txt", oldText: "hello", newText: "hello woho" }), { path: "src/hello.txt", bytes: 10, changed: true });
  assert.deepEqual(await workspace.execute({ operation: "read", path: "src/hello.txt" }), { path: "src/hello.txt", content: "hello woho" });
  await workspace.execute({ operation: "write", path: "src/repeated.txt", content: "x\nx\n" });
  await assert.rejects(() => workspace.execute({ operation: "edit", path: "src/repeated.txt", oldText: "x", newText: "y" }), /occurs multiple times/);
  assert.deepEqual(await workspace.execute({ operation: "edit", path: "src/repeated.txt", oldText: "x", newText: "y", replaceAll: true }), { path: "src/repeated.txt", bytes: 4, changed: true });
  await assert.rejects(() => workspace.execute({ operation: "edit", path: "src/repeated.txt", oldText: "missing", newText: "y" }), /not found/);
  const listing = await workspace.execute({ operation: "list", path: "src" }) as { entries: Array<{ name: string }> };
  assert.equal(listing.entries[0]?.name, "hello.txt");
  await assert.rejects(() => workspace.execute({ operation: "read", path: "../escape.txt" }), /Parent traversal/);
  await assert.rejects(() => workspace.execute({ operation: "write", path: "/tmp/escape.txt", content: "x" }), /Absolute paths/);
  const symlinkPath = join(workspaceRoot, "linked");
  try {
    await (await import("node:fs/promises")).symlink(".", symlinkPath, "dir");
    await assert.rejects(() => workspace.execute({ operation: "write", path: "linked/new.txt", content: "blocked" }), /Symbolic link ancestors/);
    await assert.rejects(() => workspace.execute({ operation: "mkdir", path: "linked/new-dir" }), /Symbolic link ancestors/);
  } finally {
    await rm(symlinkPath, { recursive: true, force: true });
  }
  assert.deepEqual(await workspace.execute({ operation: "move", path: "src/hello.txt", destination: "hello.txt" }), { from: "src/hello.txt", to: "hello.txt", moved: true });
  assert.deepEqual(await workspace.execute({ operation: "delete", path: "hello.txt" }), { path: "hello.txt", deleted: true });
  await rm(workspaceRoot, { recursive: true, force: true });

  const boundedGit = (await import("./git.js")).gitTool({ root: process.cwd(), maxPaths: 1, maxPathBytes: 10 });
  await assert.rejects(() => boundedGit.execute({ operation: "status", paths: ["a", "b"] }), /maxPaths/);
  await assert.rejects(() => boundedGit.execute({ operation: "status", paths: ["x".repeat(11)] }), /maxPathBytes/);

  const gitRoot = await mkdtemp(join(tmpdir(), "woho-git-"));
  (await import("node:child_process")).execFileSync("git", ["init"], { cwd: gitRoot, stdio: "ignore" });
  await writeFile(join(gitRoot, "README.md"), "woho\n", "utf8");
  (await import("node:child_process")).execFileSync("git", ["config", "user.email", "test@woho.invalid"], { cwd: gitRoot });
  (await import("node:child_process")).execFileSync("git", ["config", "user.name", "WoHo Test"], { cwd: gitRoot });
  const git = (await import("./git.js")).gitTool({ root: gitRoot, allowWrite: true });
  const status = await git.execute({ operation: "status" }) as { stdout: string };
  assert.deepEqual(git.authorize?.({ operation: "status" }), { capability: "git", action: "read" });
  assert.deepEqual(git.authorize?.({ operation: "commit" }), { capability: "git", action: "write" });

  const isolatedGit = (await import("./git.js")).gitTool({
    root: gitRoot,
    environment: { WOHO_TOOLS_SAFE: "yes" },
  });
  const isolatedGitStatus = await isolatedGit.execute({ operation: "status" }) as { stdout: string };
  assert.match(isolatedGitStatus.stdout, /README/);
  await assert.rejects(() => git.execute({ operation: "add", paths: ["../outside"] }), /parent traversal/);
  assert.match(status.stdout, /README/);
  await git.execute({ operation: "add", paths: ["README.md"] });
  const hookPath = join(gitRoot, ".git", "hooks", "pre-commit");
  await writeFile(hookPath, "#!/bin/sh\necho hook-ran > ../hook-ran.txt\nexit 1\n", { encoding: "utf8", mode: 0o755 });
  await git.execute({ operation: "commit", message: "test: workspace git" });
  await assert.rejects(() => import("node:fs/promises").then(({ access }) => access(join(gitRoot, ".git", "hook-ran.txt"))), /ENOENT/);
  const branch = await git.execute({ operation: "branch" }) as { stdout: string };
  assert.ok(branch.stdout.trim().length > 0);
  await rm(gitRoot, { recursive: true, force: true });
  console.log("tools runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });


  const boundedCommand = commandTool({ allowedCommands: ["node"], allowedDirectories: [process.cwd()], maxArgs: 2, maxArgBytes: 10 });
  await assert.rejects(() => boundedCommand.execute({ command: "node", args: ["-e", "123", "extra"], cwd: process.cwd() }), /maxArgs/);
  await assert.rejects(() => boundedCommand.execute({ command: "node", args: ["-e", "x".repeat(11)], cwd: process.cwd() }), /maxArgBytes/);
  await assert.rejects(() => boundedCommand.execute({ command: "node", args: ["-e", "x".repeat(11)], cwd: process.cwd() }), /maxArgBytes/);
