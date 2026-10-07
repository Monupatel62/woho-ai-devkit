import assert from "node:assert/strict";
import { InMemoryExecutionStore } from "./execution-store.js";

const store = new InMemoryExecutionStore();
store.create({
  runId: "resume-orphan",
  agent: "general",
  input: "recover me",
  metadata: {},
  status: "failed",
  startedAt: 1,
  updatedAt: 10,
  attempts: 1,
  events: [],
});

assert.equal(store.claimResume!("resume-orphan", 10, "resume-child"), "resume-child");
assert.equal(await store.claimResume!("resume-orphan", 10, "different-child"), "resume-child");
assert.equal((await store.get("resume-orphan"))?.resumeRunId, "resume-child");

console.log("resume claim recovery tests passed");
