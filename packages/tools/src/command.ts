import type { AgentTool } from "@woho/agents";
import { spawn } from "node:child_process";
import { createToolPolicy, type ToolPolicy } from "./policy.js";

export interface CommandToolPolicy extends Partial<ToolPolicy> {
  allowedCommands?: string[];
  maxOutputBytes?: number;
}

function basename(command: string): string {
  const normalized = command.trim().replaceAll("\\\\", "/");
  return normalized.split("/").pop() ?? normalized;
}

export function commandTool(inputPolicy: CommandToolPolicy = {}): AgentTool {
  const policy = createToolPolicy(inputPolicy);
  const allowedCommands = (inputPolicy.allowedCommands ?? []).map((item) => item.trim().toLowerCase()).filter(Boolean);
  const maxOutputBytes = inputPolicy.maxOutputBytes ?? 1_000_000;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("maxOutputBytes must be a positive integer");
  return {
    name: "command",
    description: "Run an explicitly allowlisted local command inside an explicitly allowed working directory.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, args: { type: "array" }, cwd: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const value = input as Record<string, unknown>;
      const command = value.command;
      const args = value.args ?? [];
      const cwd = value.cwd;
      if (typeof command !== "string" || !command.trim()) throw new Error("command is required");
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("args must be an array of strings");
      if (!allowedCommands.includes(basename(command).toLowerCase())) throw new Error("Command is not allowed by policy");
      if (typeof cwd !== "undefined" && typeof cwd !== "string") throw new Error("cwd must be a string");
      if (policy.allowedDirectories.length) {
        if (!cwd) throw new Error("cwd is required when allowedDirectories are configured");
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const target = path.resolve(await fs.realpath(cwd));
        let ok = false;
        for (const directory of policy.allowedDirectories) {
          try {
            const root = path.resolve(await fs.realpath(directory));
            if (target === root || target.startsWith(root + path.sep)) { ok = true; break; }
          } catch { /* ignored */ }
        }
        if (!ok) throw new Error("cwd is outside the allowed directories");
      }
      return new Promise((resolve, reject) => {
        const child = spawn(command, args as string[], { cwd, shell: false, windowsHide: true });
        let stdout = "";
        let stderr = "";
        let bytes = 0;
        let killed = false;
        const append = (chunk: Buffer | string, target: "stdout" | "stderr") => {
          const text = chunk.toString();
          bytes += Buffer.byteLength(text, "utf8");
          if (bytes > maxOutputBytes) {
            killed = true;
            child.kill();
            return;
          }
          if (target === "stdout") stdout += text;
          else stderr += text;
        };
        const abort = () => { killed = true; child.kill(); };
        context?.signal?.addEventListener("abort", abort, { once: true });
        child.stdout.on("data", (chunk) => append(chunk, "stdout"));
        child.stderr.on("data", (chunk) => append(chunk, "stderr"));
        const timer = setTimeout(() => { killed = true; child.kill(); }, policy.timeoutMs);
        child.on("error", (error) => { clearTimeout(timer); context?.signal?.removeEventListener("abort", abort); reject(error); });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          context?.signal?.removeEventListener("abort", abort);
          if (killed && context?.signal?.aborted) return reject(context.signal.reason ?? new Error("Command aborted"));
          if (killed && bytes > maxOutputBytes) return reject(new Error("Command output exceeds maxOutputBytes"));
          if (killed) return reject(new Error("Command timed out"));
          resolve({ command, args, cwd, code, signal, stdout, stderr });
        });
      });
    },
  };
}
