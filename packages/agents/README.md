# @woho/agents

Composable tool-calling AI agents with bounded execution, memory and MCP bridging.

Part of the [WoHo AI DevKit](https://github.com/Monupatel62/woho-ai-devkit).

## Install

```bash
pnpm add @woho/agents @woho/core
```

## Quick start

```ts
import { Agent } from "@woho/agents";
import { createAI, createMockProvider } from "@woho/core";

const ai = createAI({
  provider: createMockProvider({ response: "Hello from the agent" }),
});

const agent = new Agent(ai, {
  name: "assistant",
  instructions: "Answer briefly and clearly.",
  maxSteps: 4,
});

const result = await agent.run("Hello");
console.log(result.text);
```

Agents support bounded multi-step tool execution, optional conversation memory, context limits, tool-result limits and MCP tool bridging.

## License

Apache-2.0
