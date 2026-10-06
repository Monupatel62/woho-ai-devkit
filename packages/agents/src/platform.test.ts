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
console.log("WoHo agent platform tests passed");
