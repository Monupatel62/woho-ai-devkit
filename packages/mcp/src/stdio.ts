import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { MCPError, type MCPTransport } from "./index.js";

export interface MCPStdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxMessageBytes?: number;
}

export class MCPStdioTransport implements MCPTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly maxMessageBytes: number;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly readline;
  private nextId = 1;
  private closed = false;

  constructor(options: MCPStdioTransportOptions) {
    if (!options.command.trim()) throw new Error("MCP command is required");
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.maxMessageBytes) || this.maxMessageBytes < 1) throw new Error("maxMessageBytes must be a positive integer");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
    this.process = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.readline = createInterface({ input: this.process.stdout });
    this.readline.on("line", (line) => this.handleLine(line));
    this.process.stderr.resume();
    this.process.on("error", (error) => this.rejectAll(error));
    this.process.on("exit", (code, signal) => this.rejectAll(new MCPError(`MCP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`)));
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new MCPError("MCP stdio transport is closed"));
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    const bytes = Buffer.byteLength(message, "utf8");
    if (bytes > this.maxMessageBytes) return Promise.reject(new MCPError("MCP request exceeds maxMessageBytes", method));

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(new MCPError("MCP request aborted", method));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new MCPError("MCP request timed out", method));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(value); },
        reject: (error) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(error); },
      });
      try {
        this.process.stdin.write(message + "\n");
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new MCPError("MCP stdio transport is closed");
    const message = JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    if (Buffer.byteLength(message, "utf8") > this.maxMessageBytes) throw new MCPError("MCP notification exceeds maxMessageBytes", method);
    await new Promise<void>((resolve, reject) => this.process.stdin.write(message + "\n", (error) => error ? reject(error) : resolve()));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.readline.close();
    for (const pending of this.pending.values()) pending.reject(new MCPError("MCP stdio transport closed"));
    this.pending.clear();
    if (!this.process.killed) this.process.kill();
  }

  private handleLine(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxMessageBytes) {
      this.rejectAll(new MCPError("MCP response exceeds maxMessageBytes"));
      return;
    }
    let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
    try { message = JSON.parse(line) as typeof message; } catch {
      this.rejectAll(new MCPError("Invalid MCP JSON-RPC response"));
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new MCPError(message.error.message ?? "MCP JSON-RPC error"));
    else pending.resolve(message.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createMCPStdioTransport(options: MCPStdioTransportOptions): MCPStdioTransport {
  return new MCPStdioTransport(options);
}
