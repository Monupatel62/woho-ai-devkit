# WoHo Execution Platform

The DevKit runtime is designed around one execution loop:

**Plan → Execute → Observe → Verify → Recover → Complete**

## Runtime layers

- **Model fabric**: provider-neutral AI clients and `ModelRouter` for model-aware routing and retryable fallback.
- **Agent fabric**: `AgentRegistry`, specialized roles, bounded concurrency, dependency-aware plans, retries, and cancellation.
- **Action fabric**: permission-gated tools, explicit capabilities, approval hooks, MCP bridges, and safe command/file/network tools.
- **Memory fabric**: bounded conversation memory, ranked text search, and provider-neutral semantic search through an embedding adapter.
- **Execution fabric**: stable run IDs, parent/session metadata, execution history, lifecycle events, tool events, and status transitions.
- **Governance**: explicit permission decisions, human approval for consequential actions, path/host/command boundaries, and security-focused agents.

## Multi-agent execution

Do not create a separate npm package for every agent role. Register roles as definitions and execute them through the shared runtime.

A plan can fan out independent work and then feed completed results into dependent stages:

```ts
const result = await runAgentPlan(runtime, ai, {
  steps: [
    { id: "research", agent: "research", input: "Research the problem." },
    {
      id: "review",
      agent: "security",
      dependsOn: ["research"],
      input: ({ completed }) => `Review these findings:\n${completed.research.text}`,
    },
  ],
});
```

## Human-in-the-loop

A permission policy can return `requiresApproval: true`. The agent then calls the configured approval handler before executing the protected tool.

Applications should persist the approval decision and execution events outside process memory when they need auditability.

## Production storage

`InMemoryExecutionStore` is intentionally a reference implementation. Production applications can implement `ExecutionStore` against PostgreSQL, Redis, a durable job queue, or another persistence layer without changing the agent runtime contract.

## Verification requirements

A production host should treat an execution as complete only after:

1. all planned stages finish;
2. required approvals are satisfied;
3. tools report successful completion;
4. tests or domain-specific verification pass;
5. execution status is persisted as `succeeded`.

Failures should remain visible as failed runs with their error and event history.
