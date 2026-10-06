import type { AgentTool } from "@woho/agents";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface GitToolPolicy {
  root: string;
  allowWrite?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const readOperations = new Set(["status", "diff", "log", "branch", "show"]);
const writeOperations = new Set(["add", "reset", "commit"]);

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(name + " must be a positive integer");
}

async function safeRoot(root: string): Promise<string> {
  const real = await fs.realpath(path.resolve(root));
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error("Git root must be a directory");
  return real;
}

function assertGitPath(value: string): void {
  if (!value || path.isAbsolute(value)) throw new Error("Git paths must be non-empty relative paths");
  const normalized = value.replaceAll("\\\\", "/");
  if (normalized.split("/").some((part) => part === "..")) throw new Error("Git parent traversal is not allowed");
}

function normalizeArgs(operation: string, input: Record<string, unknown>): string[] {
  const pathArgs = input.paths;
  if (pathArgs !== undefined && (!Array.isArray(pathArgs) || pathArgs.some((item) => typeof item !== "string"))) {
    throw new Error("paths must be an array of strings");
  }
  const paths = (pathArgs as string[] | undefined) ?? [];
  paths.forEach(assertGitPath);
  if (operation === "status") return ["status", "--short", "--branch"];
  if (operation === "diff") return ["-c", "core.pager=cat", "diff", "--no-ext-diff", "--", ...paths];
  if (operation === "log") return ["log", "-n", "20", "--oneline", "--decorate"];
  if (operation === "branch") return ["branch", "--show-current"];
  if (operation === "show") return ["-c", "core.pager=cat", "show", "--no-ext-diff", "--stat", "--oneline", "HEAD"];
  if (operation === "add") {
    if (!paths.length) throw new Error("add requires at least one path");
    return ["add", "--", ...paths];
  }
  if (operation === "reset") {
    if (!paths.length) throw new Error("reset requires at least one path");
    return ["reset", "HEAD", "--", ...paths];
  }
  if (operation === "commit") {
    const message = input.message;
    if (typeof message !== "string" || !message.trim()) throw new Error("commit message is required");
    if (message.length > 200) throw new Error("commit message is too long");
    return ["-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "commit", "-m", message];
  }
  throw new Error("Unsupported git operation");
}

export function gitTool(inputPolicy: GitToolPolicy): AgentTool {
  const allowWrite = inputPolicy.allowWrite ?? false;
  const timeoutMs = inputPolicy.timeoutMs ?? 15_000;
  const maxOutputBytes = inputPolicy.maxOutputBytes ?? 1_000_000;
  positiveInteger(timeoutMs, "timeoutMs");
  positiveInteger(maxOutputBytes, "maxOutputBytes");

  return {
    name: "git",
    description: "Run a constrained Git operation inside one fixed repository root.",
    capability: "git",
    action: allowWrite ? "execute" : "read",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: [...readOperations, ...writeOperations] },
        paths: { type: "array" },
        message: { type: "string" }
      },
      required: ["operation"],
      additionalProperties: false
    },
    async execute(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const value = input as Record<string, unknown>;
      const operation = value.operation;
      if (typeof operation !== "string") throw new Error("operation is required");
      if (!readOperations.has(operation) && !writeOperations.has(operation)) throw new Error("Unsupported git operation");
      if (writeOperations.has(operation) && !allowWrite) throw new Error("Git write operations are disabled by policy");
      const cwd = await safeRoot(inputPolicy.root);
      const args = normalizeArgs(operation, value);

      return new Promise((resolve, reject) => {
        const child = spawn("git", args, {
          cwd,
          shell: false,
          windowsHide: true,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_PAGER: "cat",
            GIT_TERMINAL_PROMPT: "0",
          },
        });
        let stdout = "";
        let stderr = "";
        let bytes = 0;
        let terminated = false;
        const append = (chunk: Buffer | string, target: "stdout" | "stderr") => {
          const text = chunk.toString();
          bytes += Buffer.byteLength(text, "utf8");
          if (bytes > maxOutputBytes) {
            terminated = true;
            child.kill();
            return;
          }
          if (target === "stdout") stdout += text;
          else stderr += text;
        };
        const abort = () => { terminated = true; child.kill(); };
        context?.signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(() => { terminated = true; child.kill(); }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          context?.signal?.removeEventListener("abort", abort);
        };
        child.stdout.on("data", (chunk) => append(chunk, "stdout"));
        child.stderr.on("data", (chunk) => append(chunk, "stderr"));
        child.on("error", (error) => { cleanup(); reject(error); });
        child.on("close", (code, signal) => {
          cleanup();
          if (terminated && bytes > maxOutputBytes) return reject(new Error("Git output exceeds maxOutputBytes"));
          if (terminated && context?.signal?.aborted) return reject(new Error("Git operation aborted"));
          if (terminated) return reject(new Error("Git operation timed out"));
          if (code !== 0) return reject(new Error("Git operation failed"));
          resolve({ operation, args, code, signal, stdout, stderr });
        });
      });
    }
  };
}
