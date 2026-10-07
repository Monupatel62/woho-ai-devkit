import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileExecutionStore, InMemoryExecutionStore } from "./execution-store.js";

const makeRecord = (runId: string) => ({
  runId,
  agent: "general",
  metadata: {},
  status: "running" as const,
  startedAt: 10,
  updatedAt: 10,
  attempts: 1,
  events: [],
});

for (const createStore of [
  () => new InMemoryExecutionStore(),
  async () => new FileExecutionStore({ directory: await mkdtemp(path.join(os.tmpdir(), "woho-terminal-invariants-")) }),
]) {
  const store = await createStore();
  try {
    const runId = "terminal-" + Math.random().toString(36).slice(2);
    await store.create(makeRecord(runId));

    const lease = await store.acquireLease!(runId, "worker-a", 10_000, Date.now());
    assert.ok(lease);

    const receipt = await store.claimToolExecutionFenced!(runId, lease.fencingToken, "call-1", "a".repeat(64));
    assert.equal(receipt, undefined);

    await store.update(runId, { status: "succeeded", completedAt: 30, updatedAt: 30 });

    await assert.rejects(
      () => Promise.resolve(store.appendEvent(runId, { type: "tool.completed", runId, timestamp: 31 })),
      /terminal execution/,
    );

    await assert.rejects(
      () => Promise.resolve(store.appendEventFenced!(runId, lease.fencingToken, { type: "tool.completed", runId, timestamp: 31 })),
      /terminal execution/,
    );

    assert.equal(
      await store.completeToolExecution!(runId, "call-1", "a".repeat(64), { status: "completed", result: "late", updatedAt: 31 }),
      false,
    );

    assert.equal(
      await store.completeToolExecutionFenced!(runId, lease.fencingToken, "call-1", "a".repeat(64), { status: "completed", result: "late", updatedAt: 31 }),
      false,
    );

    await assert.rejects(
      () => Promise.resolve(store.claimToolExecution!(runId, "call-2", "b".repeat(64))),
      /terminal execution/,
    );
    assert.equal((await store.get(runId))?.toolReceipts?.["call-2"], undefined);
  } finally {
    const directory = store instanceof FileExecutionStore ? (store as unknown as { directory: string }).directory : undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

const memory = new InMemoryExecutionStore();
memory.create(makeRecord("cancel-memory"));
assert.equal(memory.cancelExecution!("cancel-memory", "cancel", 5), true);
assert.equal(memory.get("cancel-memory")?.completedAt, 10);
assert.equal(memory.get("cancel-memory")?.updatedAt, 10);

const root = await mkdtemp(path.join(os.tmpdir(), "woho-cancel-invariant-"));
try {
  const file = new FileExecutionStore({ directory: root });
  await file.create(makeRecord("cancel-file"));
  assert.equal(await file.cancelExecution("cancel-file", "cancel", 5), true);
  const cancelled = await file.get("cancel-file");
  assert.equal(cancelled?.completedAt, 10);
  assert.equal(cancelled?.updatedAt, 10);
  assert.equal(cancelled?.events.at(-1)?.timestamp, 10);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("terminal mutation invariant tests passed");
