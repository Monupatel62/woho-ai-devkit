import assert from "node:assert/strict";
import { AgentRuntime } from "./runtime.js";
import { InMemoryExecutionStore } from "./execution-store.js";

class FailingCreateStore extends InMemoryExecutionStore {
  private failOnce = true;
  override create(record: Parameters<InMemoryExecutionStore["create"]>[0]): void {
    if (this.failOnce) { this.failOnce = false; throw new Error("injected create failure"); }
    super.create(record);
  }
}
const store = new FailingCreateStore();
const runtime = new AgentRuntime({ store, maxConcurrency: 1 });
await assert.rejects(
  runtime.run({} as never, { agent: "missing-agent", input: "first", runId: "slot-first" }),
  /injected create failure/,
);
const second = runtime.run({} as never, { agent: "missing-agent", input: "second", runId: "slot-second" });
await assert.rejects(second, /Agent not found|Unknown agent|missing-agent/);
console.log("runtime setup slot leak regression passed");
