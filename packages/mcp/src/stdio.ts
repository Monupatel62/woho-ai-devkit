import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  private stdoutBuffer = Buffer.alloc(0);
  private closed = false;
  private nextId = 1;

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
    this.process.stdout.on("data", (chunk: Buffer | string) => this.handleStdout(chunk));
    this.process.stderr.resume();
    this.process.stdin.on("error", (error) => this.rejectAll(error));
    this.process.on("error", (error) => this.rejectAll(error));
    this.process.on("exit", (code, signal) => {
      this.rejectAll(new MCPError(`MCP process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new MCPError("MCP stdio transport is closed"));
    const id = this.nextId++;
    let message: string;
    try {
      message = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      return Promise.reject(new MCPError(`MCP request is not serializable: ${error instanceof Error ? error.message : String(error)}`, method));
    }
    if (Buffer.byteLength(message, "utf8") > this.maxMessageBytes) {
      return Promise.reject(new MCPError("MCP request exceeds maxMessageBytes", method));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      const succeed = (value: unknown) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        cleanup();
        resolve(value);
      };
      const onAbort = () => fail(new MCPError("MCP request aborted", method));
      if (signal?.aborted) return onAbort();

      timer = setTimeout(() => fail(new MCPError("MCP request timed out", method)), this.timeoutMs);
      const resolveWithTimer = (value: unknown) => { clearTimeout(timer); succeed(value); };
      const rejectWithTimer = (error: Error) => { clearTimeout(timer); fail(error); };
      this.pending.set(id, { resolve: resolveWithTimer, reject: rejectWithTimer });
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        this.process.stdin.write(message + "\n", (error) => {
          if (error) rejectWithTimer(error);
        });
      } catch (error) {
        rejectWithTimer(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new MCPError("MCP stdio transport is closed");
    let message: string;
    try {
      message = JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      throw new MCPError(`MCP notification is not serializable: ${error instanceof Error ? error.message : String(error)}`, method);
    }
    if (Buffer.byteLength(message, "utf8") > this.maxMessageBytes) throw new MCPError("MCP notification exceeds maxMessageBytes", method);
    await new Promise<void>((resolve, reject) => {
      try {
        this.process.stdin.write(message + "\n", (error) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new MCPError("MCP stdio transport closed"));
    this.pending.clear();
    this.stdoutBuffer = Buffer.alloc(0);
    this.process.stdout.destroy();
    this.process.stdin.destroy();
    if (!this.process.killed) this.process.kill();
  }

  private handleStdout(chunk: Buffer | string): void {
    if (this.closed) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (incoming.length === 0) return;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, incoming]);
    if (this.stdoutBuffer.length > this.maxMessageBytes && !this.stdoutBuffer.includes(0x0a)) {
      this.rejectAll(new MCPError("MCP response exceeds maxMessageBytes"));
      return;
    }

    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.length > this.maxMessageBytes) this.rejectAll(new MCPError("MCP response exceeds maxMessageBytes"));
        return;
      }
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.length > this.maxMessageBytes) {
        this.rejectAll(new MCPError("MCP response exceeds maxMessageBytes"));
        return;
      }
      this.handleLine(line.toString("utf8"));
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.rejectAll(new MCPError("Invalid MCP JSON-RPC response"));
      return;
    }
    if (message.jsonrpc !== "2.0" || (message.id !== undefined && typeof message.id !== "number")) {
      this.rejectAll(new MCPError("Invalid MCP JSON-RPC response"));
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new MCPError("MCP JSON-RPC request failed"));
    else if ("result" in message) pending.resolve(message.result);
    else pending.reject(new MCPError("Invalid MCP JSON-RPC response"));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function createMCPStdioTransport(options: MCPStdioTransportOptions): MCPStdioTransport {
  return new MCPStdioTransport(options);
}
