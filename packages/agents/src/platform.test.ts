import assert from "node:assert/strict";
import { createAI, type AIProvider } from "@woho/core";
import { createWohoAgentPlatform } from "./platform.js";

const responses = [
  JSON.stringify({ steps: [
    { id: "inspect", agent: "woho-research", input: "Inspect the requested system and report findings." },
    { id: "implement", agent: "woho-coding", input: "Implement the verified change and test it.", dependsOn: ["inspect"] },
  ] }),
  "research complete",
  "implementation complete",
];
let calls = 0;
const provider: AIProvider = {
  name: "platform-test",
  async chat() {
    const text = responses[calls++];
    if (!text) throw new Error("unexpected AI call");
    return { id: String(calls), text, model: "platform-test" };
  },
};

const platform = createWohoAgentPlatform({
  runtime: { maxConcurrency: 2 },
});
assert.equal(platform.registry.list().length, 15);
assert.ok(platform.registry.get("woho-coding"));
assert.ok(platform.registry.get("woho-browser"));
assert.ok(platform.registry.get("woho-security"));
assert.ok(platform.registry.get("woho-orchestrator"));

const projectTool = {
  name: "project_context_probe",
  description: "Probe the authorized project context.",
  capability: "file",
  action: "read" as const,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute() { return { ok: true }; },
};
const projectContextPlatform = createWohoAgentPlatform({ projectTools: [projectTool] });
assert.ok(projectContextPlatform.registry.get("woho-coding")?.tools?.some((tool) => tool.name === "project_context_probe"));
assert.ok(projectContextPlatform.registry.get("woho-file")?.tools?.some((tool) => tool.name === "project_context_probe"));
assert.ok(projectContextPlatform.registry.get("woho-testing")?.tools?.some((tool) => tool.name === "project_context_probe"));
assert.ok(projectContextPlatform.registry.get("woho-git")?.tools?.some((tool) => tool.name === "project_context_probe"));
assert.ok(projectContextPlatform.registry.get("woho-security")?.tools?.some((tool) => tool.name === "project_context_probe"));
assert.ok(projectContextPlatform.registry.get("woho-documentation")?.tools?.some((tool) => tool.name === "project_context_probe"));
assert.equal(projectContextPlatform.registry.get("woho-orchestrator")?.tools?.some((tool) => tool.name === "project_context_probe"), false);
assert.equal(projectContextPlatform.registry.get("woho-planner")?.tools?.some((tool) => tool.name === "project_context_probe"), false);

const ai = createAI({ provider });
const plan = await platform.plan(ai, "Build the requested software change.");
assert.deepEqual(plan.steps.map((step) => step.agent), ["woho-research", "woho-coding"]);
const result = await platform.runPlan(ai, plan);
assert.equal(result.order.join(","), "inspect,implement");
assert.equal(result.steps.inspect?.text, "research complete");
assert.equal(result.steps.implement?.text, "implementation complete");

let rejected = false;
try {
  await platform.plan(createAI({ provider: {
    name: "bad-planner",
    async chat() {
      return { id: "bad", text: JSON.stringify({ steps: [{ id: "x", agent: "not-available", input: "do it" }] }), model: "bad" };
    },
  }}), "unsafe plan");
} catch (error) {
  rejected = error instanceof Error && error.message.includes("unavailable");
}
assert.equal(rejected, true);

const invalidPlanner = createAI({ provider: {
  name: "invalid-planner",
  async chat() {
    return { id: "invalid", text: JSON.stringify({ steps: [
      { id: "x", agent: "woho-coding", input: "do it", dependsOn: ["x", "x"] },
    ] }), model: "invalid" };
  },
}});
let invalidRejected = false;
try { await platform.plan(invalidPlanner, "validate dependencies"); } catch (error) {
  invalidRejected = error instanceof Error && error.message.includes("self dependency");
}
assert.equal(invalidRejected, true);

const boundedPlanner = createAI({ provider: {
  name: "bounded-planner",
  async chat() {
    return { id: "bounded", text: JSON.stringify({ steps: [{ id: "x", agent: "woho-coding", input: "12345" }] }), model: "bounded" };
  },
}});
let boundedRejected = false;
try { await createWohoAgentPlatform({ maxPlanStepInputBytes: 4 }).plan(boundedPlanner, "bounded input"); } catch (error) {
  boundedRejected = error instanceof Error && error.message.includes("maxPlanStepInputBytes");
}
assert.equal(boundedRejected, true);

let codingCalls = 0;
let codingToolRuns = 0;
const codingProvider: AIProvider = {
  name: "coding-platform-test",
  async chat(request) {
    if (request.messages.some((message) => message.role === "system" && message.content.includes("strict software verification agent"))) {
      return { id: "verify", text: "PASS verified implementation and test result", model: "coding-platform-test" };
    }
    codingCalls += 1;
    if (request.messages.at(-1)?.role === "tool") {
      return { id: "coding-done", text: "implemented after inspecting project tool output", model: "coding-platform-test" };
    }
    return {
      id: "coding-tool-call",
      text: "",
      model: "coding-platform-test",
      finishReason: "tool_call",
      toolCalls: [{ id: "inspect-1", name: "project_inspect", arguments: JSON.stringify({ path: "src/app.ts" }) }],
    };
  },
};

const projectInspectTool = {
  name: "project_inspect",
  description: "Inspect an authorized project file.",
  capability: "file",
  action: "read" as const,
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input: unknown) {
    codingToolRuns += 1;
    return { inspected: (input as { path: string }).path, content: "verified project state" };
  },
};
const codingPlatform = createWohoAgentPlatform({
  toolsByRole: { coding: [projectInspectTool] },
  permissionsByRole: { coding: { check: (request) => request.capability === "file" && request.action === "read" ? { allowed: true } : { allowed: false } } },
  codingLoop: { maxAttempts: 2 },
});
const codingResult = await codingPlatform.runCodingTask(
  createAI({ provider: codingProvider }),
  "Inspect src/app.ts and implement the requested coding change.",
  { verify: "The project inspection must be performed and the implementation must be verified." },
);
assert.equal(codingResult.attempts, 1);
assert.equal(codingResult.final.text, "implemented after inspecting project tool output");
assert.equal(codingToolRuns, 1);
assert.ok(codingCalls >= 2);
console.log("WoHo agent platform tests passed");
