import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FileExecutionStore,
  InMemoryExecutionStore,
  pruneExecutionHistory,
  recoverStaleExecutions,
  type ExecutionRecord,
  type ExecutionStore,
} from "./execution-store.js";

const makeRecord = (runId: string, status: ExecutionRecord["status"], updatedAt: number): ExecutionRecord => ({
  runId,
  agent: "maintenance-test",
  metadata: {},
  status,
  startedAt: updatedAt,
  updatedAt,
  attempts: 1,
  events: [],
});

const run = async () => {
  const store = new InMemoryExecutionStore();
  await store.create(makeRecord("stale", "running", 100));
  await store.create(makeRecord("fresh", "running", 950));
  await store.create(makeRecord("done", "succeeded", 50));

  await store.create(makeRecord("waiting-stale", "waiting", 100));
  const recovered = await recoverStaleExecutions(store, { staleAfterMs: 500, now: 1000 });
  assert.equal(recovered.length, 2);
  assert.deepEqual(recovered.map((record) => record.runId).sort(), ["stale", "waiting-stale"]);
  assert.equal(store.get("stale")?.status, "failed");
  assert.equal(store.get("fresh")?.status, "running");
  assert.equal(store.get("waiting-stale")?.status, "failed");
  assert.equal(store.get("done")?.status, "succeeded");
  assert.equal(store.get("stale")?.events.at(-1)?.type, "run.failed");
  assert.deepEqual(store.get("stale")?.events.at(-1)?.data, { reason: "stale", staleAfterMs: 500 });

  const raced = store.get("fresh");
  assert.ok(raced);
  assert.equal(store.updateIf?.("fresh", raced.updatedAt - 1, { status: "failed" }), false);
  assert.equal(store.get("fresh")?.status, "running");
  assert.equal(store.updateIf?.("fresh", raced.updatedAt, { updatedAt: 951 }), true);

  const oldRemoved = await pruneExecutionHistory(store, { olderThanMs: 900, now: 1000, status: "succeeded" });
  assert.equal(oldRemoved.length, 1);
  assert.equal(oldRemoved[0]?.runId, "done");
  assert.equal(store.get("done"), undefined);

  const countStore = new InMemoryExecutionStore();
  await countStore.create(makeRecord("failed-a", "failed", 200));
  await countStore.create(makeRecord("failed-b", "failed", 300));
  const countRemoved = await pruneExecutionHistory(countStore, { maxRecords: 1, status: "failed" });
  assert.equal(countRemoved.length, 1);
  assert.equal(countRemoved[0]?.runId, "failed-a");
  assert.equal(countStore.get("failed-a"), undefined);
  assert.notEqual(countStore.get("failed-b"), undefined);

  const noDeleteStore: ExecutionStore = {
    create: async () => undefined,
    update: async () => undefined,
    appendEvent: async () => undefined,
    get: async () => undefined,
    list: async () => [],
  };
  await assert.rejects(
    () => pruneExecutionHistory(noDeleteStore, { maxRecords: 0 }),
    /does not support history removal/,
  );
  await assert.rejects(() => pruneExecutionHistory(store, {}), /requires olderThanMs or maxRecords/);
  const fileRoot = await mkdtemp(path.join(os.tmpdir(), "woho-execution-maintenance-"));
  try {
    const fileStore = new FileExecutionStore({ directory: fileRoot });
    await fileStore.create(makeRecord("file-stale", "running", 100));
    const fileRecovered = await recoverStaleExecutions(fileStore, { staleAfterMs: 50, now: 200 });
    assert.equal(fileRecovered.length, 1);
    assert.equal((await fileStore.get("file-stale"))?.status, "failed");
    const fileNewer = makeRecord("file-newer", "succeeded", 300);
    await fileStore.create(fileNewer);
    const fileRemoved = await pruneExecutionHistory(fileStore, { maxRecords: 1, status: "succeeded" });
    assert.equal(fileRemoved.length, 0);
    assert.notEqual(await fileStore.get("file-newer"), undefined);
  } finally {
    await rm(fileRoot, { recursive: true, force: true });
  }
  await assert.rejects(() => recoverStaleExecutions(store, { staleAfterMs: 0 }), /staleAfterMs/);
  await assert.rejects(() => recoverStaleExecutions(store, { staleAfterMs: 1, now: -1 }), /now/);
  console.log("execution maintenance tests passed");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
