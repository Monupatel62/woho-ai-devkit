import type { AgentTool } from "@woho/agents";

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: AgentTool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: AgentTool): this {
    if (!tool.name.trim()) throw new Error("Tool name is required");
    if (this.tools.has(tool.name)) throw new Error("Duplicate tool: " + tool.name);
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  definitions(): Array<{ name: string; description: string; parameters?: Record<string, unknown> }> {
    return this.list().map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
}

export function createToolRegistry(tools: AgentTool[] = []): ToolRegistry {
  return new ToolRegistry(tools);
}
