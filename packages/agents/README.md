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

### Dependency-aware multi-agent plans

Use `runAgentPlan` when work needs specialist stages. Independent stages run in parallel, while `dependsOn` creates explicit ordering and cycle/unknown-dependency checks.

```ts
import { Agent, AgentRegistry, AgentRuntime, runAgentPlan } from "@woho/agents";

const registry = new AgentRegistry();
registry.register({ id: "research", name: "Research" }, ({ ai }) => new Agent(ai, { name: "Research" }));
registry.register({ id: "review", name: "Review" }, ({ ai }) => new Agent(ai, { name: "Review" }));

const runtime = new AgentRuntime({ maxConcurrency: 4 }, registry);
const result = await runAgentPlan(runtime, ai, {
  steps: [
    { id: "research", agent: "research", input: "Research the task" },
    { id: "review", agent: "review", input: "Review the research", dependsOn: ["research"] },
  ],
});

console.log(result.order);
```

## License

Apache-2.0
