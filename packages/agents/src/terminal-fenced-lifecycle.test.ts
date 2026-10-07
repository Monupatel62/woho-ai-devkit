import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileExecutionStore, InMemoryExecutionStore } from "./execution-store.js";

const seed = (runId: string) => ({
  runId,
  agent: "general",
  metadata: {},
  status: "running" as const,
  startedAt: 1,
  updatedAt: 10,
  attempts: 1,
  events: [],
});

for (const store of [
  new InMemoryExecutionStore(),
  new FileExecutionStore({ directory: await mkdtemp(path.join(os.tmpdir(), "woho-terminal-fenced-")) }),
]) {
  const runId = store instanceof FileExecutionStore ? "file-terminal" : "memory-terminal";
  try {
    await store.create(seed(runId));
    const lease = await store.acquireLease!(runId, "worker", 10_000, Date.now());
    assert.ok(lease);
    await store.update(runId, { status: "succeeded", completedAt: 30, updatedAt: 30 });

    const event = { type: "tool.completed" as const, runId, timestamp: 31 };
    await assert.rejects(() => Promise.resolve().then(() => store.transition(runId, {}, event)), /terminal execution/);
    await assert.rejects(() => Promise.resolve().then(() => store.transitionFenced!(runId, lease.fencingToken, {}, event)), /terminal execution/);
    await assert.rejects(() => Promise.resolve().then(() => store.updateFenced!(runId, lease.fencingToken, { metadata: { late: true } })), /terminal execution/);

    const current = await store.get(runId);
    assert.equal(current?.status, "succeeded");
    assert.deepEqual(current?.metadata, {});
    assert.equal(current?.events.length, 0);
  } finally {
    if (store instanceof FileExecutionStore) {
      await rm((store as unknown as { directory: string }).directory, { recursive: true, force: true });
    }
  }
}

console.log("terminal fenced lifecycle tests passed");
