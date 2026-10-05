import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileExecutionStore } from "./execution-store.js";

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
    () => limited.update(record.runId, { metadata: { oversized: "x".repeat(200) } }),
    /exceeds maxRecordBytes/,
  );

  const safe = await reopened.get("../not-a-path");
  assert.equal(safe, undefined);
  console.log("file execution store tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
