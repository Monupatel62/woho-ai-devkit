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

  await assert.rejects(() => store.create({ ...record, runId: "invalid-status", status: "corrupt" as never }), /Invalid execution status/);
  await assert.rejects(() => store.create({ ...record, runId: "invalid-time", updatedAt: -1 }), /Execution updatedAt must be a non-negative finite number/);
  await assert.rejects(() => store.create({ ...record, runId: "invalid-attempts", attempts: 1.5 }), /Execution attempts must be a non-negative integer/);
  assert.throws(
    () => store.create({ ...record, runId: "missing-started-at", startedAt: undefined as never }),
    /Execution startedAt must be a non-negative finite number/,
  );
  assert.throws(
    () => store.create({ ...record, runId: "missing-updated-at", updatedAt: undefined as never }),
    /Execution updatedAt must be a non-negative finite number/,
  );
  assert.throws(
    () => store.create({
      ...record,
      runId: "invalid-event",
      events: [{ type: "not-an-event", runId: "invalid-event", timestamp: 1 }],
    } as never),
    /Invalid execution event type/,
  );
  assert.throws(
    () => store.create({
      ...record,
      runId: "invalid-event-run",
      events: [{ type: "run.started", runId: "different-run", timestamp: 1 }],
    } as never),
    /does not match execution record/,
  );
  await assert.rejects(
    () => store.appendEvent(record.runId, {
      type: "run.completed",
      runId: "different-run",
      timestamp: 2,
    }),
    /does not match execution record/,
  );
  await assert.rejects(
    () => store.appendEvent(record.runId, {
      type: "run.completed",
      runId: record.runId,
      timestamp: undefined as never,
    }),
    /Execution event timestamp must be a non-negative finite number/,
  );
  const malformedPath = path.join(root, Buffer.from("malformed-persisted", "utf8").toString("base64url") + ".json");
  await writeFile(malformedPath, JSON.stringify({
    runId: "malformed-persisted",
    agent: "general",
    metadata: {},
    status: "corrupt",
    startedAt: 1,
    updatedAt: 1,
    attempts: 0,
    events: [],
  }));
  await assert.rejects(
    () => store.get("malformed-persisted"),
    /Invalid execution status/,
  );

  const event = {
    type: "run.completed" as const,
    runId: record.runId,
    timestamp: 2,
    data: { ok: true },
  };
  await store.appendEvent(record.runId, event);
  await store.update(record.runId, { status: "succeeded", completedAt: 2, updatedAt: 2 });

  const boundedRecordSeed = { ...record, runId: "bounded-file" };
  const bounded = new FileExecutionStore({ directory: root, maxEvents: 2 });
  await bounded.create(boundedRecordSeed);
  await bounded.appendEvent(boundedRecordSeed.runId, { type: "tool.started", runId: boundedRecordSeed.runId, timestamp: 3, data: { step: 1 } });
  await bounded.appendEvent(boundedRecordSeed.runId, { type: "tool.completed", runId: boundedRecordSeed.runId, timestamp: 4, data: { step: 1 } });
  await bounded.appendEvent(boundedRecordSeed.runId, { type: "tool.started", runId: boundedRecordSeed.runId, timestamp: 5, data: { step: 2 } });
  const boundedRecord = await bounded.get(boundedRecordSeed.runId);
  assert.equal(boundedRecord?.events.length, 2);
  assert.deepEqual(boundedRecord?.events.map((item) => item.timestamp), [4, 5]);

  const inMemoryBounded = new (await import("./execution-store.js")).InMemoryExecutionStore({ maxEvents: 2 });
  const inMemorySeed = { ...record, runId: "bounded-memory" };
  await inMemoryBounded.create(inMemorySeed);
  await inMemoryBounded.appendEvent(inMemorySeed.runId, { type: "tool.started", runId: inMemorySeed.runId, timestamp: 3, data: { step: 1 } });
  await inMemoryBounded.appendEvent(inMemorySeed.runId, { type: "tool.completed", runId: inMemorySeed.runId, timestamp: 4, data: { step: 1 } });
  await inMemoryBounded.appendEvent(inMemorySeed.runId, { type: "tool.started", runId: inMemorySeed.runId, timestamp: 5, data: { step: 2 } });
  assert.deepEqual(inMemoryBounded.get(inMemorySeed.runId)?.events.map((item) => item.timestamp), [4, 5]);

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
