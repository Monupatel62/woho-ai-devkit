export interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}
export interface MCPTool { definition: MCPToolDefinition; execute(input: unknown): Promise<unknown>; }
export interface MCPResourceDefinition { uri: string; name?: string; description?: string; mimeType?: string; }
export interface MCPResourceContent { uri: string; mimeType?: string; text?: string; blob?: string; }
export interface MCPResource { definition: MCPResourceDefinition; read(): Promise<MCPResourceContent[]>; }
export interface MCPPromptArgument { name: string; description?: string; required?: boolean; }
export interface MCPPromptDefinition { name: string; description?: string; arguments?: MCPPromptArgument[]; }
export interface MCPPrompt { definition: MCPPromptDefinition; get(promptArguments?: Record<string, string>): Promise<unknown>; }
export interface MCPServerInfo { name: string; version: string; }
export interface MCPServerOptions { name: string; version: string; tools?: MCPTool[]; resources?: MCPResource[]; prompts?: MCPPrompt[]; }
export interface MCPTransport { request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>; notify?(method: string, params?: unknown): Promise<void>; close?(): Promise<void>; }
export interface MCPClientSecurityOptions {
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  allowedMethods?: string[];
  allowedToolNames?: string[];
  allowedResourceSchemes?: string[];
}
export interface MCPClientOptions { transport: MCPTransport; timeoutMs?: number; clientName?: string; clientVersion?: string; protocolVersion?: string; security?: MCPClientSecurityOptions; }
export interface MCPCallResult { content: unknown; isError: boolean; }
export class MCPError extends Error { constructor(message: string, public readonly method?: string) { super(message); this.name = "MCPError"; } }

export class MCPServer {
  readonly info: MCPServerInfo;
  private readonly tools = new Map<string, MCPTool>();
  private readonly resources = new Map<string, MCPResource>();
  private readonly prompts = new Map<string, MCPPrompt>();
  constructor(options: MCPServerOptions) {
    if (!options.name.trim()) throw new Error("MCP server name is required");
    if (!options.version.trim()) throw new Error("MCP server version is required");
    this.info = { name: options.name, version: options.version };
    for (const tool of options.tools ?? []) this.registerTool(tool);
    for (const resource of options.resources ?? []) this.registerResource(resource);
    for (const prompt of options.prompts ?? []) this.registerPrompt(prompt);
  }
  registerTool(tool: MCPTool): void {
    if (!tool.definition.name.trim()) throw new Error("MCP tool name is required");
    if (tool.definition.name !== tool.definition.name.trim()) throw new Error("MCP tool name cannot have surrounding whitespace");
    if (this.tools.has(tool.definition.name)) throw new Error("Duplicate MCP tool: " + tool.definition.name);
    this.tools.set(tool.definition.name, tool);
  }
  listTools(): MCPToolDefinition[] { return [...this.tools.values()].map((tool) => ({ ...tool.definition })); }
  registerResource(resource: MCPResource): void {
    if (!resource.definition.uri.trim()) throw new Error("MCP resource URI is required");
    if (this.resources.has(resource.definition.uri)) throw new Error("Duplicate MCP resource: " + resource.definition.uri);
    this.resources.set(resource.definition.uri, resource);
  }
  listResources(): MCPResourceDefinition[] { return [...this.resources.values()].map((resource) => ({ ...resource.definition })); }
  async readResource(uri: string): Promise<MCPResourceContent[]> {
    const resource = this.resources.get(uri);
    if (!resource) throw new Error("Unknown MCP resource: " + uri);
    return resource.read();
  }
  registerPrompt(prompt: MCPPrompt): void {
    if (!prompt.definition.name.trim()) throw new Error("MCP prompt name is required");
    if (prompt.definition.name !== prompt.definition.name.trim()) throw new Error("MCP prompt name cannot have surrounding whitespace");
    if (this.prompts.has(prompt.definition.name)) throw new Error("Duplicate MCP prompt: " + prompt.definition.name);
    this.prompts.set(prompt.definition.name, prompt);
  }
  listPrompts(): MCPPromptDefinition[] { return [...this.prompts.values()].map((prompt) => ({ ...prompt.definition })); }
  async getPrompt(name: string, promptArguments?: Record<string, string>): Promise<unknown> {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new Error("Unknown MCP prompt: " + name);
    return prompt.get(promptArguments);
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
  private readonly maxResponseBytes: number;
  private readonly maxRequestBytes: number;
  private readonly allowedMethods?: Set<string>;
  private readonly allowedToolNames?: Set<string>;
  private readonly allowedResourceSchemes?: Set<string>;
  private initialized = false;
  private closed = false;
  private initialization?: Promise<unknown>;
  constructor(options: MCPClientOptions) {
    if (!Number.isInteger(options.timeoutMs ?? 30000) || (options.timeoutMs ?? 30000) < 1) throw new Error("timeoutMs must be a positive integer");
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.clientName = options.clientName ?? "woho-ai-devkit";
    this.clientVersion = options.clientVersion ?? "0.6.13";
    this.protocolVersion = options.protocolVersion ?? "2025-06-18";
    if (!this.clientName.trim()) throw new Error("clientName is required");
    if (!this.clientVersion.trim()) throw new Error("clientVersion is required");
    if (!this.protocolVersion.trim()) throw new Error("protocolVersion is required");
    this.maxResponseBytes = options.security?.maxResponseBytes ?? 4 * 1024 * 1024;
    this.maxRequestBytes = options.security?.maxRequestBytes ?? 1 * 1024 * 1024;
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error("maxResponseBytes must be a positive integer");
    if (!Number.isInteger(this.maxRequestBytes) || this.maxRequestBytes < 1) throw new Error("maxRequestBytes must be a positive integer");
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error("maxResponseBytes must be a positive integer");
    if (options.security?.allowedMethods) {
      if (!Array.isArray(options.security.allowedMethods) || options.security.allowedMethods.some((method) => typeof method !== "string" || !method.trim())) throw new Error("allowedMethods must contain non-empty strings");
    }
    this.allowedMethods = options.security?.allowedMethods ? new Set(options.security.allowedMethods) : undefined;
    this.allowedToolNames = options.security?.allowedToolNames ? new Set(options.security.allowedToolNames) : undefined;
    this.allowedResourceSchemes = options.security?.allowedResourceSchemes ? new Set(options.security.allowedResourceSchemes) : undefined;
  }
  async initialize(): Promise<unknown> {
    if (this.closed) throw new MCPError("MCP client is closed");
    if (this.initialized) return this.initialization;
    if (!this.initialization) {
      this.initialization = (async () => {
        const result = await this.request("initialize", { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: this.clientName, version: this.clientVersion } });
        if (this.closed) throw new MCPError("MCP client is closed");
        if (this.transport.notify) await this.transport.notify("notifications/initialized");
        if (this.closed) throw new MCPError("MCP client is closed");
        this.initialized = true;
        return result;
      })().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }
  async listResources(): Promise<MCPResourceDefinition[]> {
    await this.initialize();
    const value = await this.request("resources/list") as { resources?: MCPResourceDefinition[] };
    return Array.isArray(value?.resources) ? value.resources : [];
  }
  async readResource(uri: string): Promise<MCPResourceContent[]> {
    if (!uri.trim()) throw new Error("resource uri is required");
    if (this.allowedResourceSchemes) {
      const scheme = uri.includes(":") ? uri.slice(0, uri.indexOf(":")).toLowerCase() : "";
      if (!this.allowedResourceSchemes.has(scheme)) throw new MCPError("MCP resource scheme is not allowed: " + scheme, "resources/read");
    }
    await this.initialize();
    const value = await this.request("resources/read", { uri });
    return Array.isArray((value as { contents?: MCPResourceContent[] })?.contents) ? (value as { contents?: MCPResourceContent[] }).contents! : [];
  }
  async listPrompts(): Promise<MCPPromptDefinition[]> {
    await this.initialize();
    const value = await this.request("prompts/list") as { prompts?: MCPPromptDefinition[] };
    return Array.isArray(value?.prompts) ? value.prompts : [];
  }
  async getPrompt(name: string, promptArguments?: Record<string, string>): Promise<unknown> {
    if (!name.trim()) throw new Error("prompt name is required");
    if (name !== name.trim()) throw new Error("prompt name cannot have surrounding whitespace");
    await this.initialize();
    return this.request("prompts/get", { name, ...(promptArguments ? { arguments: promptArguments } : {}) });
  }
  async listTools(): Promise<MCPToolDefinition[]> {
    await this.initialize();
    const value = await this.request("tools/list") as { tools?: MCPToolDefinition[] };
    return Array.isArray(value?.tools) ? value.tools : [];
  }
  async callTool(name: string, input: unknown = {}): Promise<MCPCallResult> {
    if (!name.trim()) throw new Error("tool name is required");
    if (this.allowedToolNames && !this.allowedToolNames.has(name)) throw new MCPError("MCP tool is not allowed: " + name, "tools/call");
    if (name !== name.trim()) throw new Error("tool name cannot have surrounding whitespace");
    await this.initialize();
    const result = await this.request("tools/call", { name, arguments: input }) as { content?: unknown; isError?: boolean };
    return { content: result?.content ?? [], isError: result?.isError === true };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close?.();
  }
  private async request(method: string, params?: unknown): Promise<unknown> {
    if (!method.trim()) throw new MCPError("MCP method is required");
    if (this.closed) throw new MCPError("MCP client is closed", method);
    if (this.allowedMethods && !this.allowedMethods.has(method)) throw new MCPError("MCP method is not allowed: " + method, method);
    let requestBytes = 0;
    try { requestBytes = Buffer.byteLength(JSON.stringify(params ?? {}), "utf8"); } catch { throw new MCPError("MCP request is not serializable", method); }
    if (requestBytes > this.maxRequestBytes) throw new MCPError("MCP request exceeds maxRequestBytes", method);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new MCPError("MCP request timed out: " + method, method));
      }, this.timeoutMs);
    });
    const request = this.transport.request(method, params, controller.signal);
    try {
      const result = await Promise.race([request, timeout]);
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(result) ?? "", "utf8"); } catch { throw new MCPError("MCP response is not serializable", method); }
      if (bytes > this.maxResponseBytes) throw new MCPError("MCP response exceeds maxResponseBytes", method);
      return result;
    } catch (error) {
      if (error instanceof MCPError) throw error;
      if (controller.signal.aborted) throw new MCPError("MCP request timed out: " + method, method);
      throw new MCPError(error instanceof Error ? error.message : String(error), method);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
export function createMCPClient(options: MCPClientOptions): MCPClient { return new MCPClient(options); }
export { MCPStdioTransport, createMCPStdioTransport, type MCPStdioTransportOptions } from "./stdio.js";
export function createMCPServer(options: MCPServerOptions): MCPServer { return new MCPServer(options); }
