import assert from "node:assert/strict";
import {
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

  const recovered = await recoverStaleExecutions(store, { staleAfterMs: 500, now: 1000 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.runId, "stale");
  assert.equal(store.get("stale")?.status, "failed");
  assert.equal(store.get("fresh")?.status, "running");
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

  await store.create(makeRecord("failed-a", "failed", 200));
  await store.create(makeRecord("failed-b", "failed", 300));
  const countRemoved = await pruneExecutionHistory(store, { maxRecords: 1, status: "failed" });
  assert.equal(countRemoved.length, 1);
  assert.equal(countRemoved[0]?.runId, "failed-a");
  assert.notEqual(store.get("failed-b"), undefined);

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
  assert.throws(() => pruneExecutionHistory(store, {}), /requires olderThanMs or maxRecords/);
  assert.throws(() => recoverStaleExecutions(store, { staleAfterMs: 0 }), /staleAfterMs/);
  assert.throws(() => recoverStaleExecutions(store, { staleAfterMs: 1, now: -1 }), /now/);
  console.log("execution maintenance tests passed");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
