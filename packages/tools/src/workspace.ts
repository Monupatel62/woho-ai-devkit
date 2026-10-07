import type { AgentTool } from "@woho/agents";
import { createToolPolicy, type ToolPolicy } from "./policy.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface WorkspaceToolPolicy extends Partial<ToolPolicy> {
  root: string;
  allowDelete?: boolean;
  allowMove?: boolean;
  allowWrite?: boolean;
  maxEntries?: number;
}

export interface WorkspaceEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size?: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(name + " must be a positive integer");
}

async function realRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  const real = await fs.realpath(resolved);
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new Error("Workspace root must be a directory");
  return real;
}

function assertRelative(input: string): void {
  if (!input || typeof input !== "string") throw new Error("path is required");
  if (path.isAbsolute(input)) throw new Error("Absolute paths are not allowed");
  const normalized = input.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "..")) throw new Error("Parent traversal is not allowed");
}

async function rejectSymlink(root: string, relative: string): Promise<void> {
  assertRelative(relative);
  const target = path.resolve(root, relative);
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed for this operation");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function safeExisting(root: string, relative: string): Promise<string> {
  assertRelative(relative);
  const target = path.resolve(root, relative);
  const real = await fs.realpath(target);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error("Path escapes the workspace root");
  return real;
}

async function rejectSymlinkAncestors(root: string, relative: string): Promise<void> {
  assertRelative(relative);
  const parts = relative.replaceAll("\\\\", "/").split("/").filter(Boolean);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Symbolic link ancestors are not allowed");
      if (!stat.isDirectory()) throw new Error("Path ancestor is not a directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
  }
}

async function safeParent(root: string, relative: string): Promise<{ target: string; parent: string }> {
  assertRelative(relative);
  await rejectSymlinkAncestors(root, relative);
  const target = path.resolve(root, relative);
  const requestedParent = path.dirname(target);
  let existingParent = requestedParent;
  while (true) {
    try {
      const realParent = await fs.realpath(existingParent);
      if (realParent !== root && !realParent.startsWith(root + path.sep)) throw new Error("Parent escapes the workspace root");
      return { target, parent: requestedParent };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = path.dirname(existingParent);
      if (next === existingParent) throw new Error("Workspace parent does not exist");
      existingParent = next;
    }
  }
}

function entryType(stat: Awaited<ReturnType<typeof fs.lstat>>): WorkspaceEntry["type"] {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "symlink";
}

export function createWorkspaceTool(inputPolicy: WorkspaceToolPolicy): AgentTool {
  const policy = createToolPolicy(inputPolicy);
  const maxEntries = inputPolicy.maxEntries ?? 500;
  positiveInteger(maxEntries, "maxEntries");
  const canWrite = inputPolicy.allowWrite ?? false;
  const canDelete = inputPolicy.allowDelete ?? false;
  const canMove = inputPolicy.allowMove ?? false;
  const capability = "file";
  let operationTail = Promise.resolve();

  return {
    name: "workspace",
    description: "Safely inspect and modify files inside one fixed workspace root using relative paths.",
    capability,
    action: "read",
    authorize(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const operation = (input as Record<string, unknown>).operation;
      const action = operation === "list" || operation === "read" ? "read" : "write";
      const resource = typeof (input as Record<string, unknown>).path === "string" ? (input as Record<string, unknown>).path as string : undefined;
      return { capability, action, ...(resource ? { resource } : {}) };
    },
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["list", "read", "write", "edit", "mkdir", "delete", "move"] },
        path: { type: "string" },
        content: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
        replaceAll: { type: "boolean" },
        destination: { type: "string" },
        recursive: { type: "boolean" }
      },
      required: ["operation"],
      additionalProperties: false
    },
    async execute(input, context) {
      const previous = operationTail;
      let release!: () => void;
      operationTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const value = input as Record<string, unknown>;
      const operation = value.operation;
      if (typeof operation !== "string") throw new Error("operation is required");
      const root = await realRoot(policy.allowedDirectories[0] ?? inputPolicy.root);
      const relative = value.path;
      if (operation !== "list" && typeof relative !== "string") throw new Error("path is required");

      if (operation === "list") {
        const target = typeof relative === "string" ? await safeExisting(root, relative) : root;
        const stat = await fs.stat(target);
        if (!stat.isDirectory()) throw new Error("list target must be a directory");
        const names = await fs.readdir(target, { withFileTypes: true });
        if (names.length > maxEntries) throw new Error("Directory contains too many entries");
        return { path: typeof relative === "string" ? relative : ".", entries: await Promise.all(names.map(async (entry) => {
          const full = path.join(target, entry.name);
          const info = await fs.lstat(full);
          return { name: entry.name, type: entryType(info), size: info.isFile() ? info.size : undefined };
        })) };
      }

      if (operation === "read") {
        const target = await safeExisting(root, relative as string);
        const handle = await fs.open(target, process.platform === "win32" ? "r" : fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > policy.maxFileBytes) throw new Error("File is missing, not regular, or too large");
          const decoder = new StringDecoder("utf8");
          const chunks: string[] = [];
          const buffer = Buffer.alloc(Math.min(64 * 1024, policy.maxFileBytes + 1));
          let total = 0;
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > policy.maxFileBytes) throw new Error("File is missing, not regular, or too large");
            chunks.push(decoder.write(buffer.subarray(0, bytesRead)));
          }
          chunks.push(decoder.end());
          return { path: relative, content: chunks.join("") };
        } finally {
          await handle.close().catch(() => undefined);
        }
      }

      if (operation === "edit") {
        if (!canWrite) throw new Error("Workspace write is disabled by policy");
        if (typeof relative !== "string") throw new Error("path is required");
        const oldText = value.oldText;
        const newText = value.newText;
        const replaceAll = value.replaceAll === true;
        if (typeof oldText !== "string" || oldText.length === 0) throw new Error("oldText is required");
        if (typeof newText !== "string") throw new Error("newText is required");
        if (Buffer.byteLength(oldText, "utf8") > policy.maxFileBytes || Buffer.byteLength(newText, "utf8") > policy.maxFileBytes) {
          throw new Error("Edit text exceeds maxFileBytes");
        }
        await rejectSymlinkAncestors(root, relative);
        const target = path.resolve(root, relative);
        const expected = await fs.lstat(target);
        if (expected.isSymbolicLink()) throw new Error("Refusing symlink for this operation");
        if (!expected.isFile()) throw new Error("File is missing, not regular, or too large");
        const handle = await fs.open(target, process.platform === "win32" ? "r+" : fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > policy.maxFileBytes || stat.dev !== expected.dev || stat.ino !== expected.ino) {
            throw new Error("File is missing, not regular, or too large");
          }
          const decoder = new StringDecoder("utf8");
          const chunks: string[] = [];
          const buffer = Buffer.alloc(Math.min(64 * 1024, policy.maxFileBytes + 1));
          let total = 0;
          while (true) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > policy.maxFileBytes) throw new Error("File is missing, not regular, or too large");
            chunks.push(decoder.write(buffer.subarray(0, bytesRead)));
          }
          chunks.push(decoder.end());
          const current = chunks.join("");
          const first = current.indexOf(oldText);
          if (first < 0) throw new Error("oldText was not found");
          if (!replaceAll && current.indexOf(oldText, first + oldText.length) >= 0) {
            throw new Error("oldText occurs multiple times; use replaceAll=true");
          }
          const updated = replaceAll ? current.split(oldText).join(newText) : current.slice(0, first) + newText + current.slice(first + oldText.length);
          if (Buffer.byteLength(updated, "utf8") > policy.maxFileBytes) throw new Error("Edited file exceeds maxFileBytes");
          await handle.truncate(0);
          const output = Buffer.from(updated, "utf8");
          let written = 0;
          while (written < output.length) {
            const result = await handle.write(output, written, output.length - written, written);
            written += result.bytesWritten;
          }
          return { path: relative, bytes: Buffer.byteLength(updated, "utf8"), changed: true };
        } finally {
          await handle.close().catch(() => undefined);
        }
      }

      if (operation === "write") {
        if (!canWrite) throw new Error("Workspace write is disabled by policy");
        if (typeof value.content !== "string") throw new Error("content is required");
        if (Buffer.byteLength(value.content, "utf8") > policy.maxFileBytes) throw new Error("Content exceeds maxFileBytes");
        const { target, parent } = await safeParent(root, relative as string);
        await fs.mkdir(parent, { recursive: true });
        let existing: Awaited<ReturnType<typeof fs.lstat>> | undefined;
        try {
          existing = await fs.lstat(target);
          if (existing.isSymbolicLink()) throw new Error("Refusing to write through a symlink");
          if (existing.isDirectory()) throw new Error("Cannot write a directory");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const flags = process.platform === "win32"
          ? existing ? "r+" : "wx"
          : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
        const handle = await fs.open(target, flags, 0o600);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino))) {
            throw new Error("Refusing to write through a replaced file");
          }
          await handle.truncate(0);
          await handle.writeFile(value.content, "utf8");
        } finally {
          await handle.close().catch(() => undefined);
        }
        return { path: relative, bytes: Buffer.byteLength(value.content, "utf8") };
      }

      if (operation === "mkdir") {
        if (!canWrite) throw new Error("Workspace write is disabled by policy");
        const { target } = await safeParent(root, relative as string);
        await rejectSymlink(root, relative as string);
        await fs.mkdir(target, { recursive: true, mode: 0o700 });
        await safeExisting(root, relative as string);
        return { path: relative, created: true };
      }

      if (operation === "delete") {
        if (!canDelete) throw new Error("Workspace delete is disabled by policy");
        await rejectSymlink(root, relative as string);
        const target = await safeExisting(root, relative as string);
        if (target === root) throw new Error("Workspace root cannot be deleted");
        const recursive = value.recursive === true;
        const stat = await fs.lstat(target);
        if (stat.isDirectory() && !recursive) throw new Error("Directory deletion requires recursive=true");
        await fs.rm(target, { recursive, force: false });
        return { path: relative, deleted: true };
      }

      if (operation === "move") {
        if (!canMove) throw new Error("Workspace move is disabled by policy");
        if (typeof value.destination !== "string") throw new Error("destination is required");
        await rejectSymlink(root, relative as string);
        await rejectSymlink(root, value.destination);
        const source = await safeExisting(root, relative as string);
        const { target: destination, parent } = await safeParent(root, value.destination);
        await fs.mkdir(parent, { recursive: true });
        try {
          const existing = await fs.lstat(destination);
          if (existing.isSymbolicLink()) throw new Error("Refusing to replace a symlink");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await fs.rename(source, destination);
        return { from: relative, to: value.destination, moved: true };
      }

      throw new Error("Unsupported workspace operation");
      } finally {
        release();
      }
    }
  };
}

export { createWorkspaceTool as workspaceTool };
