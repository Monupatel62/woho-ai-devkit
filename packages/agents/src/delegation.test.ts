import assert from "node:assert/strict";
import { createAI, createMockProvider } from "@woho/core";
import { Agent, AgentRegistry, AgentRuntime, createAgentDelegationTool } from "./index.js";

const ai = createAI({ provider: createMockProvider({ response: "specialist result" }) });
const registry = new AgentRegistry();
registry.register({ id: "research", name: "Research", role: "research" }, ({ ai: agentAI }) =>
  new Agent(agentAI, { name: "Research", maxSteps: 1 }),
);
const runtime = new AgentRuntime({ maxConcurrency: 2 }, registry);
const delegation = createAgentDelegationTool(runtime, ai, registry);

const result = await delegation.execute({ agent: "research", task: "inspect this" }, { runId: "parent-run" });
assert.equal((result as { agent: string }).agent, "research");
assert.equal((result as { text: string }).text, "specialist result");

await assert.rejects(
  delegation.execute({ agent: "missing", task: "inspect" }, { runId: "parent-run" }),
  /Unknown agent/,
);

const limited = createAgentDelegationTool(runtime, ai, registry, { maxDepth: 1 });
await assert.rejects(
  limited.execute({ agent: "research", task: "inspect", depth: 1 }, { runId: "parent-run" }),
  /Delegation depth limit exceeded/,
);

const restricted = createAgentDelegationTool(runtime, ai, registry, { allowedAgents: ["other"] });
await assert.rejects(
  restricted.execute({ agent: "research", task: "inspect" }, { runId: "parent-run" }),
  /not allowed/,
);

console.log("agent delegation tests passed");
