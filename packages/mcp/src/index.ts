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

export function createMCPServer(options: MCPServerOptions): MCPServer {
  return new MCPServer(options);
}
