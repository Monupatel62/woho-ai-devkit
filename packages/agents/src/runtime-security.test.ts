import test from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "./runtime.js";
import { InMemoryExecutionStore } from "./execution-store.js";
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
  const store = new InMemoryExecutionStore();
  const runtime = new AgentRuntime({
    maxErrorMessageBytes: 256,
    store,
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
  const record = store.get("run-error-redaction");
  assert.ok(record);
  assert.equal(record.status, "failed");
  assert.equal(record.error, message);
  assert.ok(Buffer.byteLength(record.error, "utf8") <= 256);
  assert.doesNotMatch(record.error, /super-secret-token/);
});

test("runtime rejects invalid error-message limit", () => {
  assert.throws(() => new AgentRuntime({ maxErrorMessageBytes: 0 }));
});

test("runtime enforces wall-clock execution timeout", async () => {
  const registry = new AgentRegistry();
  registry.register({ id: "slow", name: "Slow", role: "general" }, () => ({
    run: async (_input: string, options: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw options.signal?.reason ?? new Error("timed out");
    },
  } as unknown as Agent));
  const store = new InMemoryExecutionStore();
  const runtime = new AgentRuntime({ store, executionTimeoutMs: 20 }, registry);
  await assert.rejects(
    () => runtime.run({} as never, { agent: "slow", input: "test", runId: "run-timeout" }),
    /timed out|Execution timed out/,
  );
  assert.equal(store.get("run-timeout")?.status, "failed");
});

test("runtime telemetry is structured and excludes task/tool payloads", async () => {
  const telemetry: Array<Record<string, unknown>> = [];
  const registry = new AgentRegistry();
  registry.register({ id: "telemetry-agent", name: "Telemetry Agent", role: "general" }, () => ({
    run: async () => ({ text: "ok", steps: 1, messages: [], toolResults: {} }),
  } as unknown as Agent));
  const runtime = new AgentRuntime({
    onTelemetry: (event) => { telemetry.push({ ...event }); },
  }, registry);
  await runtime.run({} as never, {
    agent: "telemetry-agent",
    input: "PRIVATE TASK PAYLOAD",
    runId: "telemetry-run",
    projectId: "project-observe",
  });
  assert.equal(telemetry[0]?.type, "run.started");
  assert.equal(telemetry.at(-1)?.type, "run.completed");
  assert.equal(telemetry[0]?.projectId, "project-observe");
  assert.equal("input" in telemetry[0]!, false);
  assert.equal("error" in telemetry.at(-1)!, false);
});
