import assert from "node:assert/strict";
import { AgentRuntime } from "./runtime.js";
import { InMemoryExecutionStore } from "./execution-store.js";

const store = new InMemoryExecutionStore();
const runtime = new AgentRuntime({ store, maxConcurrency: 1 });
const first = runtime.run({} as never, { agent: "missing-agent", input: "first", runId: "slot-first" });
await assert.rejects(first);
const second = await runtime.run({} as never, { agent: "missing-agent", input: "second", runId: "slot-second" }).catch((error) => error);
assert.ok(second instanceof Error, "second run should execute and fail on agent lookup, not hang behind a leaked slot");
assert.doesNotMatch(second.message, /timed out/i);
console.log("runtime setup slot leak regression passed");
