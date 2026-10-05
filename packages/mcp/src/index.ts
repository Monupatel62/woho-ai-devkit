export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPTool {
  definition: MCPToolDefinition;
  execute(input: unknown): Promise<unknown>;
}

export interface MCPServerInfo {
  name: string;
  version: string;
}

export interface MCPServerOptions {
  name: string;
  version: string;
  tools?: MCPTool[];
}

export interface MCPTransport {
  request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
  notify?(method: string, params?: unknown): Promise<void>;
  close?(): Promise<void>;
}

export interface MCPClientOptions {
  transport: MCPTransport;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  protocolVersion?: string;
}

export interface MCPCallResult {
  content: unknown;
  isError: boolean;
}

export class MCPError extends Error {
  constructor(message: string, public readonly method?: string) {
    super(message);
    this.name = "MCPError";
  }
}

export class MCPServer {
  readonly info: MCPServerInfo;
  private readonly tools = new Map<string, MCPTool>();

  constructor(options: MCPServerOptions) {
    if (!options.name.trim()) throw new Error("MCP server name is required");
    if (!options.version.trim()) throw new Error("MCP server version is required");
    this.info = { name: options.name, version: options.version };
    for (const tool of options.tools ?? []) this.registerTool(tool);
  }

  registerTool(tool: MCPTool): void {
    if (!tool.definition.name.trim()) throw new Error("MCP tool name is required");
    if (this.tools.has(tool.definition.name)) throw new Error("Duplicate MCP tool: " + tool.definition.name);
    this.tools.set(tool.definition.name, tool);
  }

  listTools(): MCPToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({ ...tool.definition }));
  }

  async callTool(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error("Unknown MCP tool: " + name);
    return tool.execute(input);
  }
}

export class MCPClient {
  private readonly transport: MCPTransport;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly protocolVersion: string;
  private initialized = false;

  constructor(options: MCPClientOptions) {
    if (!Number.isInteger(options.timeoutMs ?? 30000) || (options.timeoutMs ?? 30000) < 1) {
      throw new Error("timeoutMs must be a positive integer");
    }
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.clientName = options.clientName ?? "woho-ai-devkit";
    this.clientVersion = options.clientVersion ?? "0.6.0";
    this.protocolVersion = options.protocolVersion ?? "2025-06-18";
  }

  async initialize(): Promise<unknown> {
    if (this.initialized) return undefined;
    const result = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    });
    if (this.transport.notify) await this.transport.notify("notifications/initialized");
    this.initialized = true;
    return result;
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    await this.initialize();
    const result = await this.request("tools/list");
    const value = result as { tools?: MCPToolDefinition[] };
    return Array.isArray(value?.tools) ? value.tools : [];
  }

  async callTool(name: string, input: unknown = {}): Promise<MCPCallResult> {
    if (!name.trim()) throw new Error("tool name is required");
    await this.initialize();
    const result = await this.request("tools/call", { name, arguments: input }) as { content?: unknown; isError?: boolean };
    return { content: result?.content ?? [], isError: result?.isError === true };
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.transport.request(method, params, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new MCPError("MCP request timed out: " + method, method);
      if (error instanceof MCPError) throw error;
      throw new MCPError(error instanceof Error ? error.message : String(error), method);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createMCPClient(options: MCPClientOptions): MCPClient {
  return new MCPClient(options);
}

export function createMCPServer(options: MCPServerOptions): MCPServer {
  return new MCPServer(options);
}
