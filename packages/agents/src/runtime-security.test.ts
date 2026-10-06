import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "./runtime.js";
import { AgentRegistry, type AgentDefinition } from "./definition.js";
import type { Agent } from "./index.js";

const definition: AgentDefinition = {
  id: "failing-agent",
  name: "Failing Agent",
  role: "general",
};

test("runtime bounds and redacts persisted failure messages", async () => {
  const registry = new AgentRegistry();
  const secret = "Bearer super-secret-token sk-12345678901234567890 ghp_123456789012345678901234";
  registry.register(definition, () => ({
    run: async () => { throw new Error(secret + " " + "x".repeat(10_000)); }
  } as unknown as Agent));

  const events: Array<{ type: string; data?: Readonly<Record<string, unknown>> }> = [];
  const runtime = new AgentRuntime({
    maxErrorMessageBytes: 256,
    onEvent: (event) => { events.push(event); },
  }, registry);

  await assert.rejects(() => runtime.run({} as never, { agent: definition.id, input: "test", runId: "run-error-redaction" }));
  const failed = events.find((event) => event.type === "run.failed");
  assert.ok(failed);
  const message = String(failed.data?.error);
  assert.ok(Buffer.byteLength(message, "utf8") <= 256);
  assert.doesNotMatch(message, /super-secret-token/);
  assert.doesNotMatch(message, /sk-12345678901234567890/);
  assert.doesNotMatch(message, /ghp_123456789012345678901234/);
  assert.match(message, /REDACTED/);
});

test("runtime rejects invalid error-message limit", () => {
  assert.throws(() => new AgentRuntime({ maxErrorMessageBytes: 0 }));
});
