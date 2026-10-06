import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileExecutionStore } from "./execution-store.js";

assert.throws(() => new (FileExecutionStore as typeof FileExecutionStore)({ directory: os.tmpdir(), maxEvents: 0 }), /maxEvents must be a positive integer/);

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

  const bounded = new FileExecutionStore({ directory: root, maxEvents: 2 });
  await bounded.appendEvent(record.runId, { type: "tool.started", runId: record.runId, timestamp: 3, data: { step: 1 } });
  await bounded.appendEvent(record.runId, { type: "tool.completed", runId: record.runId, timestamp: 4, data: { step: 1 } });
  await bounded.appendEvent(record.runId, { type: "tool.started", runId: record.runId, timestamp: 5, data: { step: 2 } });
  const boundedRecord = await bounded.get(record.runId);
  assert.equal(boundedRecord?.events.length, 2);
  assert.deepEqual(boundedRecord?.events.map((item) => item.timestamp), [4, 5]);

  const inMemoryBounded = new (await import("./execution-store.js")).InMemoryExecutionStore({ maxEvents: 2 });
  await inMemoryBounded.create(record);
  await inMemoryBounded.appendEvent(record.runId, { type: "tool.started", runId: record.runId, timestamp: 3, data: { step: 1 } });
  await inMemoryBounded.appendEvent(record.runId, { type: "tool.completed", runId: record.runId, timestamp: 4, data: { step: 1 } });
  await inMemoryBounded.appendEvent(record.runId, { type: "tool.started", runId: record.runId, timestamp: 5, data: { step: 2 } });
  assert.deepEqual(inMemoryBounded.get(record.runId)?.events.map((item) => item.timestamp), [4, 5]);

  const writerA = new FileExecutionStore({ directory: root });
  const writerB = new FileExecutionStore({ directory: root });
  await Promise.all([
    writerA.update(record.runId, { input: "from-a" }),
    writerB.update(record.runId, { sessionId: "from-b" }),
  ]);
  const merged = await writerA.get(record.runId);
  assert.equal(merged?.input, "from-a");
  assert.equal(merged?.sessionId, "from-b");

  const lockPath = path.join(root, ".execution-store.lock");
  await writeFile(lockPath, "active", { flag: "w", mode: 0o600 });
  const blocked = new FileExecutionStore({ directory: root, lockTimeoutMs: 40, lockRetryMs: 5, lockStaleMs: 1_000 });
  await assert.rejects(
    () => blocked.update(record.runId, { input: "blocked" }),
    /Timed out acquiring execution store lock/,
  );
  await rm(lockPath, { force: true });

  await writeFile(lockPath, "abandoned", { flag: "w", mode: 0o600 });
  const staleTime = new Date(Date.now() - 10_000);
  await utimes(lockPath, staleTime, staleTime);
  const recoveredLock = new FileExecutionStore({ directory: root, lockTimeoutMs: 100, lockRetryMs: 5, lockStaleMs: 50 });
  await recoveredLock.update(record.runId, { input: "after-stale-lock" });
  assert.equal((await recoveredLock.get(record.runId))?.input, "after-stale-lock");
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

  const safe = await reopened.get("../not-a-path");
  assert.equal(safe, undefined);
  console.log("file execution store tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
