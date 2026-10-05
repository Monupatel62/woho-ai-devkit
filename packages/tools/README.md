# @woho/tools

Security-focused reusable tools including calculator, JSON, text, HTTP, file, search, workspace and Git tools.

Part of the [WoHo AI DevKit](https://github.com/Monupatel62/woho-ai-devkit).

## Install

```bash
pnpm add @woho/tools @woho/agents
```

## Quick start

```ts
import { builtInTools } from "@woho/tools";

const result = await builtInTools.calculator.execute({
  expression: "12 * 8",
});

console.log(result);
```

HTTP and file tools require explicit security policy configuration. Search tools use provider adapters and bounded result limits.\n\n## Workspace and Git execution\n\n`workspaceTool({ root, ...policy })` exposes relative-path `list`, `read`, `write`, `mkdir`, `delete`, and `move` operations inside one fixed root. Writes, deletes, and moves are opt-in and traversal/symlink boundaries are enforced.\n\n`gitTool({ root, allowWrite })` exposes constrained `status`, `diff`, `log`, `branch`, `show`, `add`, `reset`, and `commit` operations. Git writes are disabled by default and execution supports cancellation and bounded output.\n\n```ts\nimport { gitTool, workspaceTool } from "@woho/tools";\n\nconst workspace = workspaceTool({ root: process.cwd(), allowWrite: true });\nconst git = gitTool({ root: process.cwd(), allowWrite: true });\n\nawait workspace.execute({ operation: "read", path: "README.md" });\nawait git.execute({ operation: "status" });\n```

## License

Apache-2.0
