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
export interface MCPPrompt { definition: MCPPromptDefinition; get(arguments?: Record<string, string>): Promise<unknown>; }
export interface MCPServerInfo { name: string; version: string; }
export interface MCPServerOptions { name: string; version: string; tools?: MCPTool[]; resources?: MCPResource[]; prompts?: MCPPrompt[]; }
export interface MCPTransport { request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>; notify?(method: string, params?: unknown): Promise<void>; close?(): Promise<void>; }
export interface MCPClientSecurityOptions { maxResponseBytes?: number; allowedMethods?: string[]; }
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
    if (this.prompts.has(prompt.definition.name)) throw new Error("Duplicate MCP prompt: " + prompt.definition.name);
    this.prompts.set(prompt.definition.name, prompt);
  }
  listPrompts(): MCPPromptDefinition[] { return [...this.prompts.values()].map((prompt) => ({ ...prompt.definition })); }
  async getPrompt(name: string, arguments?: Record<string, string>): Promise<unknown> {
    const prompt = this.prompts.get(name);
    if (!prompt) throw new Error("Unknown MCP prompt: " + name);
    return prompt.get(arguments);
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
  private readonly allowedMethods?: Set<string>;
  private initialized = false;
  constructor(options: MCPClientOptions) {
    if (!Number.isInteger(options.timeoutMs ?? 30000) || (options.timeoutMs ?? 30000) < 1) throw new Error("timeoutMs must be a positive integer");
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.clientName = options.clientName ?? "woho-ai-devkit";
    this.clientVersion = options.clientVersion ?? "0.6.6";
    this.protocolVersion = options.protocolVersion ?? "2025-06-18";
    this.maxResponseBytes = options.security?.maxResponseBytes ?? 4 * 1024 * 1024;
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) throw new Error("maxResponseBytes must be a positive integer");
    if (options.security?.allowedMethods) {
      if (!Array.isArray(options.security.allowedMethods) || options.security.allowedMethods.some((method) => typeof method !== "string" || !method.trim())) throw new Error("allowedMethods must contain non-empty strings");
    }
    this.allowedMethods = options.security?.allowedMethods ? new Set(options.security.allowedMethods) : undefined;
  }
  async initialize(): Promise<unknown> {
    if (this.initialized) return undefined;
    const result = await this.request("initialize", { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: this.clientName, version: this.clientVersion } });
    if (this.transport.notify) await this.transport.notify("notifications/initialized");
    this.initialized = true;
    return result;
  }
  async listResources(): Promise<MCPResourceDefinition[]> {
    await this.initialize();
    const value = await this.request("resources/list") as { resources?: MCPResourceDefinition[] };
    return Array.isArray(value?.resources) ? value.resources : [];
  }
  async readResource(uri: string): Promise<MCPResourceContent[]> {
    await this.initialize();
    const value = await this.request("resources/read", { uri });
    return Array.isArray((value as { contents?: MCPResourceContent[] })?.contents) ? (value as { contents?: MCPResourceContent[] }).contents! : [];
  }
  async listPrompts(): Promise<MCPPromptDefinition[]> {
    await this.initialize();
    const value = await this.request("prompts/list") as { prompts?: MCPPromptDefinition[] };
    return Array.isArray(value?.prompts) ? value.prompts : [];
  }
  async getPrompt(name: string, arguments?: Record<string, string>): Promise<unknown> {
    if (!name.trim()) throw new Error("prompt name is required");
    await this.initialize();
    return this.request("prompts/get", { name, ...(arguments ? { arguments } : {}) });
  }
  async listTools(): Promise<MCPToolDefinition[]> {
    await this.initialize();
    const value = await this.request("tools/list") as { tools?: MCPToolDefinition[] };
    return Array.isArray(value?.tools) ? value.tools : [];
  }
  async callTool(name: string, input: unknown = {}): Promise<MCPCallResult> {
    if (!name.trim()) throw new Error("tool name is required");
    await this.initialize();
    const result = await this.request("tools/call", { name, arguments: input }) as { content?: unknown; isError?: boolean };
    return { content: result?.content ?? [], isError: result?.isError === true };
  }
  async close(): Promise<void> { await this.transport.close?.(); }
  private async request(method: string, params?: unknown): Promise<unknown> {
    if (this.allowedMethods && !this.allowedMethods.has(method)) throw new MCPError("MCP method is not allowed: " + method, method);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await this.transport.request(method, params, controller.signal);
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(result) ?? "", "utf8"); } catch { throw new MCPError("MCP response is not serializable", method); }
      if (bytes > this.maxResponseBytes) throw new MCPError("MCP response exceeds maxResponseBytes", method);
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new MCPError("MCP request timed out: " + method, method);
      if (error instanceof MCPError) throw error;
      throw new MCPError(error instanceof Error ? error.message : String(error), method);
    } finally { clearTimeout(timer); }
  }
}
export function createMCPClient(options: MCPClientOptions): MCPClient { return new MCPClient(options); }
export { MCPStdioTransport, createMCPStdioTransport, type MCPStdioTransportOptions } from "./stdio.js";
export function createMCPServer(options: MCPServerOptions): MCPServer { return new MCPServer(options); }
