# @woho/mcp

Provider-neutral MCP server/client primitives, resources, prompts and stdio transport.

Part of the [WoHo AI DevKit](https://github.com/Monupatel62/woho-ai-devkit).

## Install

```bash
pnpm add @woho/mcp
```

## Quick start

```ts
import { createMCPServer } from "@woho/mcp";

const server = createMCPServer({
  name: "demo",
  version: "1.0.0",
  tools: [
    {
      definition: {
        name: "hello",
        description: "Return a greeting",
      },
      async execute() {
        return { message: "hello" };
      },
    },
  ],
});

console.log(server.listTools());
```

For external MCP processes, use `createMCPClient` or `createMCPStdioTransport`. Client methods enforce request timeouts, response limits and optional method allowlists.

## License

Apache-2.0
