import assert from "node:assert/strict";
import { InMemoryExecutionStore, FileExecutionStore, type ExecutionRecord } from "./execution-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const seed = (runId: string): ExecutionRecord => ({
  runId, agent: "general", metadata: {}, status: "running", startedAt: 1, updatedAt: 1, attempts: 1, events: [],
});

async function exercise(store: InMemoryExecutionStore | FileExecutionStore): Promise<void> {
  const runId = "lease-reacquire";
  const now = Date.now();
  await store.create(seed(runId));
  const first = await store.acquireLease!(runId, "worker-a", 10_000, now);
  assert.ok(first);
  assert.equal(await store.acquireLease!(runId, "worker-a", 10_000, now + 1), undefined);
  assert.equal(await store.acquireLease!(runId, "worker-b", 10_000, now + 1), undefined);
  assert.equal((await store.get(runId))?.lease?.fencingToken, first.fencingToken);
  assert.equal(await store.releaseLease!(runId, "worker-a", first.fencingToken, now + 2), true);
  const second = await store.acquireLease!(runId, "worker-b", 10_000, now + 3);
  assert.equal(second?.fencingToken, first.fencingToken + 1);
}

await exercise(new InMemoryExecutionStore());
const directory = await mkdtemp(path.join(os.tmpdir(), "woho-lease-reacquire-"));
try {
  await exercise(new FileExecutionStore({ directory }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log("lease reacquire fencing tests passed");
