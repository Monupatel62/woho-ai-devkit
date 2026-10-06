import { createAgent } from "@woho/agents";
import { createAI, type PermissionPolicy } from "@woho/core";
import { createOpenAIProvider } from "@woho/provider-openai";
import { createInMemoryStore } from "@woho/memory";
import { createProjectTools } from "@woho/tools";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION = "0.1.0";

function usage(): string {
  return [
    "WoHo AI CLI",
    "",
    "Usage:",
    "  woho <request>                 Ask the project agent to inspect your project",
    "  woho --root <path> <request>   Use a specific project root",
    "  woho --help                    Show help",
    "  woho --version                 Show version",
    "",
    "Environment:",
    "  OPENAI_API_KEY                 Required for AI requests",
    "  OPENAI_MODEL                   Optional model (default: gpt-4o-mini)",
    "  OPENAI_BASE_URL                Optional OpenAI-compatible HTTPS endpoint",
    "",
    "Safety:",
    "  Project tools are scoped to the selected root.",
    "  File writes and command execution are not enabled in this first CLI release."
  ].join("\n");
}

function parseArgs(argv: string[]): { root: string; prompt?: string; help: boolean; version: boolean } {
  let root = process.cwd();
  const parts: string[] = [];
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--version" || arg === "-v") { version = true; continue; }
    if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new Error("--root requires a path");
      root = path.resolve(value);
      continue;
    }
    if (arg?.startsWith("--")) throw new Error("Unknown option: " + arg);
    if (arg) parts.push(arg);
  }
  return { root, prompt: parts.join(" ").trim() || undefined, help, version };
}

function createReadOnlyPermissions(): PermissionPolicy {
  return {
    check(request) {
      if (request.capability === "file" && request.action === "read") return { allowed: true };
      return { allowed: false, reason: "CLI policy allows read-only project inspection" };
    }
  };
}

export function createProjectAgent(root: string, apiKey: string, model: string, baseUrl?: string) {
  if (!existsSync(root)) throw new Error("Project root does not exist: " + root);
  const provider = createOpenAIProvider({ apiKey, defaultModel: model, ...(baseUrl ? { baseUrl } : {}) });
  const ai = createAI({ provider });
  const memory = createInMemoryStore({ maxMessages: 100 });
  const tools = createProjectTools({
    root,
    workspace: { allowWrite: false, allowDelete: false, allowMove: false, maxEntries: 500 }
  });
  return createAgent(ai, {
    name: "woho-cli",
    role: "local project analyst",
    instructions: [
      "You are WoHo CLI, a local project analysis agent.",
      "Inspect the user's project before making claims about files, code, configuration, tests, or git state.",
      "Never claim to have edited files or run commands; this CLI release is read-only.",
      "Prefer concise findings with file paths and concrete next steps."
    ].join(" "),
    tools,
    permissions: createReadOnlyPermissions(),
    memory,
    sessionId: root,
    maxSteps: 8,
    maxContextMessages: 20,
    maxContextChars: 30_000,
    maxToolResultChars: 30_000,
    maxToolCallsPerStep: 16,
    maxToolArgumentBytes: 128 * 1024,
    toolTimeoutMs: 30_000
  });
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(usage() + "\n"); return 0; }
  if (args.version) { process.stdout.write(VERSION + "\n"); return 0; }
  if (!args.prompt) { process.stdout.write(usage() + "\n"); return 0; }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey?.trim()) {
    process.stderr.write("OPENAI_API_KEY is required for AI requests.\n");
    return 2;
  }
  const agent = createProjectAgent(
    args.root,
    apiKey,
    process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    process.env.OPENAI_BASE_URL?.trim() || undefined
  );
  const result = await agent.run(args.prompt, { runId: "cli-" + Date.now() });
  process.stdout.write(result.text.trim() + "\n");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runCli().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : "WoHo CLI failed") + "\n");
    process.exitCode = 1;
  });
}
