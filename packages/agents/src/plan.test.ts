import test from "node:test";
import assert from "node:assert/strict";
import { runAgentPlan } from "./plan.js";
import type { AgentRunResult } from "./index.js";
import type { AgentTask } from "./runtime.js";

test("planned executions preserve project scope", async () => {
  let observed: AgentTask | undefined;
  const runtime = {
    async run(_ai: unknown, task: AgentTask): Promise<AgentRunResult & { runId: string }> {
      observed = task;
      return { runId: "planned-run", text: "ok", steps: 1, messages: [], toolResults: {} };
    },
  } as never;
  const result = await runAgentPlan(runtime, {} as never, {
    steps: [{ id: "step-1", agent: "coding", input: "do it" }],
  }, {
    projectContext: {
      projectId: "project-boundary",
      root: "/safe/project",
      sessionId: "session-boundary",
      metadata: { projectId: "project-boundary", projectRoot: "/safe/project" },
    },
  });
  assert.equal(result.steps["step-1"]?.text, "ok");
  assert.equal(observed?.projectId, "project-boundary");
  assert.equal(observed?.sessionId, "session-boundary");
});
