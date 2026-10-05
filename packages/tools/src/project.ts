import type { AgentTool } from "@woho/agents";
import { commandTool, type CommandToolPolicy } from "./command.js";
import { gitTool, type GitToolPolicy } from "./git.js";
import { workspaceTool, type WorkspaceToolPolicy } from "./workspace.js";

export interface ProjectToolsPolicy {
  readonly root: string;
  readonly workspace?: Omit<WorkspaceToolPolicy, "root">;
  readonly git?: Omit<GitToolPolicy, "root">;
  readonly command?: Omit<CommandToolPolicy, "allowedDirectories">;
}

export function createProjectTools(policy: ProjectToolsPolicy): AgentTool[] {
  if (!policy.root.trim()) throw new Error("Project root is required");

  const root = policy.root;
  const tools: AgentTool[] = [
    workspaceTool({
      ...policy.workspace,
      root,
      allowedDirectories: [root],
    }),
    gitTool({
      ...policy.git,
      root,
    }),
  ];

  const allowedCommands = policy.command?.allowedCommands ?? [];
  if (allowedCommands.length > 0) {
    tools.push(commandTool({
      ...policy.command,
      allowedDirectories: [root],
    }));
  }

  return tools;
}
