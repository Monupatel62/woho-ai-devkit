import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileExecutionStore, InMemoryExecutionStore, pruneExecutionHistory, recoverStaleExecutions } from "./execution-store.js";

const root = await mkdtemp(path.join(os.tmpdir(), "woho-execution-store-"));
try {
  const store = new FileExecutionStore({ directory: root });
  const record = {
    runId: "run-file-1",
    agent: "general",
    metadata: { source: "test" },
    status: "running" as const,
    startedAt: 1,
    updatedAt: 1,
    attempts: 1,
    events: [],
  };

  await store.create(record);
  assert.deepEqual(await store.get(record.runId), record);
  await assert.rejects(() => store.create(record), /already exists/);

  const event = {
    type: "run.completed" as const,
    runId: record.runId,
    timestamp: 2,
    data: { ok: true },
  };
  await store.appendEvent(record.runId, event);
  await store.update(record.runId, { status: "succeeded", completedAt: 2, updatedAt: 2 });

  const reopened = new FileExecutionStore({ directory: root });
  const loaded = await reopened.get(record.runId);
  assert.equal(loaded?.status, "succeeded");
  assert.equal(loaded?.completedAt, 2);
  assert.deepEqual(loaded?.events, [event]);

  const listed = await reopened.list({ status: "succeeded", limit: 1 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.runId, record.runId);

  const limited = new FileExecutionStore({ directory: root, maxRecordBytes: 100 });
  await assert.rejects(
    () => limited.create({ ...record, runId: "oversized", metadata: { oversized: "x".repeat(200) } }),
    /exceeds maxRecordBytes/,
  );

  const stale = {
    ...record,
    runId: "stale-run",
    updatedAt: 100,
    startedAt: 100,
    status: "running" as const,
  };
  await reopened.create(stale);
  const fresh = {
    ...record,
    runId: "fresh-run",
    updatedAt: 950,
    startedAt: 950,
    status: "running" as const,
  };
  await reopened.create(fresh);
  const recovered = await recoverStaleExecutions(reopened, { staleAfterMs: 500, now: 1000 });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.runId, "stale-run");
  assert.equal(recovered[0]?.status, "failed");
  assert.match(recovered[0]?.error ?? "", /stale/);
  assert.equal(recovered[0]?.events.at(-1)?.type, "run.failed");
  assert.equal((await reopened.get("fresh-run"))?.status, "running");

  const raced = await reopened.get("fresh-run");
  assert.ok(raced);
  assert.equal(await reopened.updateIf?.("fresh-run", (raced?.updatedAt ?? 0) - 1, { status: "failed" }), false);
  assert.equal((await reopened.get("fresh-run"))?.status, "running");

  await reopened.create({ ...record, runId: "old-run", startedAt: 10, updatedAt: 10 });
  await reopened.create({ ...record, runId: "new-run", startedAt: 900, updatedAt: 900 });
  const pruned = await pruneExecutionHistory(reopened, { olderThanMs: 500, now: 1000 });
  assert.ok(pruned.some((item) => item.runId === "old-run"));
  assert.equal(await reopened.get("old-run"), undefined);
  assert.notEqual(await reopened.get("new-run"), undefined);

  const memory = new InMemoryExecutionStore();
  await memory.create({ ...record, runId: "memory-old", startedAt: 1, updatedAt: 1 });
  await memory.create({ ...record, runId: "memory-new", startedAt: 900, updatedAt: 900 });
  const memoryRecovered = await recoverStaleExecutions(memory, { staleAfterMs: 100, now: 1000 });
  assert.equal(memoryRecovered.length, 1);
  assert.equal(memoryRecovered[0]?.runId, "memory-old");
  const memoryPruned = await pruneExecutionHistory(memory, { maxRecords: 0, status: "failed" });
  assert.equal(memoryPruned.length, 1);
  assert.equal(memory.get("memory-old"), undefined);
  assert.notEqual(memory.get("memory-new"), undefined);

  const safe = await reopened.get("../not-a-path");
  assert.equal(safe, undefined);
  assert.equal(await reopened.remove?.("missing-run"), false);
  assert.throws(() => pruneExecutionHistory(reopened, {}), /requires olderThanMs or maxRecords/);
  assert.throws(() => recoverStaleExecutions(reopened, { staleAfterMs: 0 }), /staleAfterMs/);
  console.log("file execution store tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
