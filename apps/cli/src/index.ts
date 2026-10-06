import { createAgent } from "@woho/agents";
import { createAI, type PermissionPolicy } from "@woho/core";
import { createOpenAIProvider } from "@woho/provider-openai";
import { createInMemoryStore } from "@woho/memory";
import { createProjectTools } from "@woho/tools";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const VERSION = "0.2.0";

interface CliOptions {
  root: string;
  prompt?: string;
  help: boolean;
  version: boolean;
  allowWrite: boolean;
  allowDelete: boolean;
  allowMove: boolean;
  allowGitWrite: boolean;
  allowedCommands: string[];
}

function usage(): string {
  return [
    "WoHo AI CLI",
    "",
    "Usage:",
    "  woho <request>                         Ask the project agent to inspect or work on your project",
    "  woho --root <path> <request>           Use a specific project root",
    "  woho --allow-write <request>           Allow file write/edit/mkdir operations",
    "  woho --allow-delete <request>          Allow file deletion",
    "  woho --allow-move <request>            Allow file moves",
    "  woho --allow-git-write <request>       Allow git add/reset/commit",
    "  woho --allow-command <name> <request>  Allow one local command (repeatable)",
    "  woho --help                            Show help",
    "  woho --version                         Show version",
    "",
    "Safety:",
    "  Project tools are always scoped to the selected root.",
    "  File/git writes and command execution are deny-by-default.",
    "  Each write/command capability must be explicitly enabled by a CLI flag.",
    "  Commands are allowlisted by executable name and run without a shell.",
    "",
    "Environment:",
    "  OPENAI_API_KEY                 Required for AI requests",
    "  OPENAI_MODEL                   Optional model (default: gpt-4o-mini)",
    "  OPENAI_BASE_URL                Optional OpenAI-compatible HTTPS endpoint",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  let root = process.cwd();
  const parts: string[] = [];
  let help = false;
  let version = false;
  let allowWrite = false;
  let allowDelete = false;
  let allowMove = false;
  let allowGitWrite = false;
  const allowedCommands: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--version" || arg === "-v") { version = true; continue; }
    if (arg === "--allow-write") { allowWrite = true; continue; }
    if (arg === "--allow-delete") { allowDelete = true; continue; }
    if (arg === "--allow-move") { allowMove = true; continue; }
    if (arg === "--allow-git-write") { allowGitWrite = true; continue; }
    if (arg === "--allow-command") {
      const command = argv[++i];
      if (!command?.trim()) throw new Error("--allow-command requires a command name");
      allowedCommands.push(command.trim());
      continue;
    }
    if (arg === "--root") {
      const value = argv[++i];
      if (!value) throw new Error("--root requires a path");
      root = path.resolve(value);
      continue;
    }
    if (arg?.startsWith("--")) throw new Error("Unknown option: " + arg);
    if (arg) parts.push(arg);
  }

  return { root, prompt: parts.join(" ").trim() || undefined, help, version, allowWrite, allowDelete, allowMove, allowGitWrite, allowedCommands };
}

function createPermissions(options: CliOptions): PermissionPolicy {
  return {
    check(request) {
      if (request.capability === "file" && request.action === "read") return { allowed: true };
      if (request.capability === "file" && request.action === "write") {
        return options.allowWrite ? { allowed: true } : { allowed: false, reason: "File writes require --allow-write" };
      }
      if (request.capability === "git" && request.action === "read") return { allowed: true };
      if (request.capability === "git" && request.action === "write") {
        return options.allowGitWrite ? { allowed: true } : { allowed: false, reason: "Git writes require --allow-git-write" };
      }
      if (request.capability === "command" && request.action === "execute") {
        return options.allowedCommands.length > 0
          ? { allowed: true }
          : { allowed: false, reason: "Command execution requires --allow-command" };
      }
      return { allowed: false, reason: "CLI policy denies this capability" };
    }
  };
}

export function createProjectAgent(
  root: string,
  apiKey: string,
  model: string,
  baseUrl?: string,
  options: Pick<CliOptions, "allowWrite" | "allowDelete" | "allowMove" | "allowGitWrite" | "allowedCommands"> = {
    allowWrite: false,
    allowDelete: false,
    allowMove: false,
    allowGitWrite: false,
    allowedCommands: [],
  }
) {
  if (!existsSync(root)) throw new Error("Project root does not exist: " + root);
  const provider = createOpenAIProvider({ apiKey, defaultModel: model, ...(baseUrl ? { baseUrl } : {}) });
  const ai = createAI({ provider });
  const memory = createInMemoryStore({ maxMessages: 100 });
  const tools = createProjectTools({
    root,
    workspace: {
      allowWrite: options.allowWrite,
      allowDelete: options.allowDelete,
      allowMove: options.allowMove,
      maxEntries: 500
    },
    git: { allowWrite: options.allowGitWrite },
    ...(options.allowedCommands.length ? { command: { allowedCommands: options.allowedCommands } } : {}),
  });
  return createAgent(ai, {
    name: "woho-cli",
    role: "local autonomous project agent",
    instructions: [
      "You are WoHo CLI, a local autonomous project agent.",
      "Inspect the user's project before making claims about files, code, configuration, tests, or git state.",
      "Only perform mutations or commands that are enabled by the active CLI permissions.",
      "After making a change, inspect or test the result when the available tools permit it.",
      "Never claim an action succeeded unless the tool returned success.",
      "Prefer minimal, scoped changes and concise evidence with file paths and command results."
    ].join(" "),
    tools,
    permissions: createPermissions({ ...options, root, prompt: undefined, help: false, version: false }),
    memory,
    sessionId: root,
    maxSteps: 16,
    maxContextMessages: 20,
    maxContextChars: 30_000,
    maxToolResultChars: 30_000,
    maxToolCallsPerStep: 16,
    maxToolArgumentBytes: 128 * 1024,
    toolTimeoutMs: 30_000
  });
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  let args: CliOptions;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "Invalid arguments") + "\n");
    return 2;
  }
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
    process.env.OPENAI_BASE_URL?.trim() || undefined,
    args
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
