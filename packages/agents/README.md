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

Plan steps may derive their input from completed results:

```ts
{ id: "review", agent: "review", dependsOn: ["research"], input: ({ completed }) => `Review: ${completed.research?.text}` }
```

### Execution history and retries

`AgentRuntime` can persist run state and retry transient agent failures. `InMemoryExecutionStore` provides a local store. `FileExecutionStore` adds durable JSON-file persistence with atomic replacement, bounded record size, and process-local serialized writes; it can be replaced with a database-backed implementation.

```ts
import { AgentRuntime, InMemoryExecutionStore } from "@woho/agents";

const store = new InMemoryExecutionStore();
const runtime = new AgentRuntime({
  store,
  retry: { maxAttempts: 3, delayMs: 250, backoff: 2 },
  heartbeatIntervalMs: 15_000,
});
```

Runtime events include run lifecycle and tool execution events, making the execution layer observable by a future UI or external telemetry system.

### Crash recovery and retention

A durable store can be inspected after a process restart. `AgentRuntime` persists periodic heartbeats while a run is active and also records tool/approval lifecycle events, so active long-running runs are less likely to be mistaken for stale work. `recoverStaleExecutions` marks runs that have stopped advancing as failed, using a compare-and-set update when the store supports it. Recovery is explicit and defaults to the `running` and `waiting` states; waiting covers interrupted retry backoff. Approval waits remain `running` until the caller resolves them.

```ts
import { FileExecutionStore, AgentRuntime } from "@woho/agents";

const runtime = new AgentRuntime({
  store: new FileExecutionStore({ directory: "./.woho/executions" }),
});

const recovered = await runtime.recoverStale({ staleAfterMs: 60_000 });
console.log("recovered:", recovered.map((run) => run.runId));
```

Failed or cancelled persisted runs can be restarted with `runtime.resume(ai, runId)`. Resume creates a new run linked to the original through `parentRunId`, so the original failure remains part of the history. Older records created before input persistence cannot be resumed automatically.

By default, the runtime persists task input to support durable resume, bounded to 1 MiB of UTF-8 data. For workloads where prompts may contain secrets or personal data, disable input persistence with `persistInput: false`; those runs remain observable but cannot be resumed after process restart. You can lower or raise the bound with `maxInputBytes` when your storage and data policy allow it. Lifecycle events do not include the original task input.

Execution history is never deleted automatically. Use `pruneExecutionHistory` or `runtime.pruneHistory` with an age and/or count policy when retention cleanup is explicitly desired.

```ts
await runtime.pruneHistory({
  olderThanMs: 7 * 24 * 60 * 60 * 1000,
  status: "succeeded",
});
```

Count-based retention keeps the newest `maxRecords` matching the optional status and removes older records. Age and count filters can be combined for a conservative cleanup policy. Set `heartbeatIntervalMs` below the stale-recovery threshold you use for production workers.

## License

Apache-2.0
