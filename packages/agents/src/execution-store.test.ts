import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileExecutionStore, InMemoryExecutionStore } from "./execution-store.js";

assert.throws(() => new (FileExecutionStore as typeof FileExecutionStore)({ directory: os.tmpdir(), maxEvents: 0 }), /maxEvents must be a positive integer/);

const root = await mkdtemp(path.join(os.tmpdir(), "woho-execution-store-"));
try {
  const store = new FileExecutionStore({ directory: root });
  const record = {
    runId: "run-file-1",
    projectId: "project-alpha",
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
  await assert.rejects(
    () => store.create({ ...record, runId: "missing-started-at", startedAt: undefined as never }),
    /Execution startedAt must be a non-negative finite number/,
  );
  await assert.rejects(
    () => store.create({ ...record, runId: "missing-updated-at", updatedAt: undefined as never }),
    /Execution updatedAt must be a non-negative finite number/,
  );
  await assert.rejects(
    () => store.create({
      ...record,
      runId: "invalid-event",
      events: [{ type: "not-an-event", runId: "invalid-event", timestamp: 1 }],
    } as never),
    /Invalid execution event type/,
  );
  await assert.rejects(
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
  await rm(malformedPath, { force: true });

  await assert.rejects(
    () => store.appendEvent(record.runId, {
      type: "tool.started",
      runId: record.runId,
      timestamp: 0,
    }),
    /cannot move execution history backwards/,
  );
  await assert.rejects(
    () => store.appendEvent(record.runId, {
      type: "tool.started",
      runId: record.runId,
      timestamp: 0.5,
    }),
    /cannot move execution history backwards/,
  );
  const event = {
    type: "run.completed" as const,
    runId: record.runId,
    timestamp: 2,
    data: { ok: true, eventId: "event-1" },
  };
  await store.appendEvent(record.runId, event);
  await assert.rejects(
    () => store.appendEvent(record.runId, {
      type: "run.completed",
      runId: record.runId,
      timestamp: 2,
      data: { eventId: "event-1" },
    }),
    /Duplicate execution eventId/,
  );
  await store.update(record.runId, { status: "succeeded", completedAt: 2, updatedAt: 2 });

  const boundedRecordSeed = { ...record, runId: "bounded-file", projectId: "project-bounded" };
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
    writerA.update(record.runId, { error: "from-a" }),
    writerB.update(record.runId, { availableAt: 123 }),
  ]);
  const merged = await writerA.get(record.runId);
  assert.equal(merged?.error, "from-a");
  assert.equal(merged?.availableAt, 123);

  const lockPath = path.join(root, ".execution-store.lock");
  await writeFile(lockPath, "active", { flag: "w", mode: 0o600 });
  const blocked = new FileExecutionStore({ directory: root, lockTimeoutMs: 40, lockRetryMs: 5, lockStaleMs: 1_000 });
  await assert.rejects(
    () => blocked.update(record.runId, { error: "blocked" }),
    /Timed out acquiring execution store lock/,
  );
  await rm(lockPath, { force: true });

  await writeFile(lockPath, "abandoned", { flag: "w", mode: 0o600 });
  const staleTime = new Date(Date.now() - 10_000);
  await utimes(lockPath, staleTime, staleTime);
  const recoveredLock = new FileExecutionStore({ directory: root, lockTimeoutMs: 100, lockRetryMs: 5, lockStaleMs: 50 });
  await recoveredLock.update(record.runId, { error: "after-stale-lock" });
  assert.equal((await recoveredLock.get(record.runId))?.error, "after-stale-lock");

  await writeFile(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() - 10_000 }), { flag: "w", mode: 0o600 });
  await utimes(lockPath, staleTime, staleTime);
  const liveOwner = new FileExecutionStore({ directory: root, lockTimeoutMs: 40, lockRetryMs: 5, lockStaleMs: 20 });
  await assert.rejects(
    () => liveOwner.update(record.runId, { error: "must-not-steal-live-lock" }),
    /Timed out acquiring execution store lock/,
  );
  await rm(lockPath, { force: true });
  const reopened = new FileExecutionStore({ directory: root });
  const loaded = await reopened.get(record.runId);
  assert.equal(loaded?.status, "succeeded");
  assert.equal(loaded?.completedAt, 2);
  assert.deepEqual(loaded?.events, [event]);

  const listed = await reopened.list({ status: "succeeded", limit: 1 });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.runId, record.runId);

  const projectListed = await reopened.list({ projectId: "project-alpha" });
  assert.equal(projectListed.length, 1);
  assert.equal(projectListed[0]?.projectId, "project-alpha");
  const otherProject = { ...record, runId: "project-beta-run", projectId: "project-beta" };
  await reopened.create(otherProject);
  assert.deepEqual((await reopened.list({ projectId: "project-beta" })).map((item) => item.runId), ["project-beta-run"]);

  const limited = new FileExecutionStore({ directory: root, maxRecordBytes: 100 });
  await assert.rejects(
    () => limited.create({ ...record, runId: "oversized", metadata: { oversized: "x".repeat(200) } }),
    /exceeds maxRecordBytes/,
  );

  const safe = await reopened.get("../not-a-path");
  assert.equal(safe, undefined);
  const checkpointStore = new InMemoryExecutionStore();
checkpointStore.create({
  runId: "checkpoint-monotonic",
  agent: "general",
  metadata: {},
  status: "running",
  startedAt: 1,
  updatedAt: 200,
  attempts: 1,
  events: [],
  checkpoint: {
    step: 2,
    messages: [],
    updatedAt: 200,
  },
});
assert.throws(
  () => checkpointStore.update("checkpoint-monotonic", {
    checkpoint: { step: 1, messages: [], updatedAt: 100 },
    updatedAt: 200,
  }),
  /checkpoint cannot move backwards/,
);
assert.equal(checkpointStore.get("checkpoint-monotonic")?.checkpoint?.step, 2);

console.log("file execution store tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}

const approvalStore = new InMemoryExecutionStore();
const approvalRun = {
  runId: "approval-audit-run",
  projectId: "project-alpha",
  agent: "woho-coding",
  input: "approve a protected action",
  metadata: {},
  status: "running" as const,
  startedAt: 1,
  updatedAt: 1,
  attempts: 1,
  events: [],
  approval: {
    approvalId: "approval-1",
    callId: "call-1",
    status: "pending" as const,
    tool: "project_write",
    capability: "file",
    action: "write",
    reason: "Protected project change",
    requestedAt: 2,
  },
};
approvalStore.create(approvalRun);
assert.equal(approvalStore.get("approval-audit-run")?.approval?.status, "pending");
assert.equal(approvalStore.resolveApproval?.("approval-audit-run", "wrong-id", true), false);
assert.equal(approvalStore.resolveApproval?.("approval-audit-run", "approval-1", true, "owner approved", 3), true);
assert.equal(approvalStore.get("approval-audit-run")?.approval?.status, "approved");
assert.equal(approvalStore.get("approval-audit-run")?.approval?.decidedAt, 3);
assert.equal(approvalStore.get("approval-audit-run")?.status, "running");
assert.equal(approvalStore.resolveApproval?.("approval-audit-run", "approval-1", false), false);
const checkpointStore = new InMemoryExecutionStore();
await checkpointStore.create({
  runId: "checkpoint-run",
  agent: "general",
  metadata: {},
  status: "failed",
  startedAt: 10,
  updatedAt: 20,
  completedAt: 20,
  attempts: 1,
  events: [],
  checkpoint: {
    step: 2,
    messages: [{ role: "user", content: "continue" }],
    updatedAt: 20,
  },
});
assert.equal(checkpointStore.get("checkpoint-run")?.checkpoint?.step, 2);
assert.equal(checkpointStore.get("checkpoint-run")?.checkpoint?.messages.length, 1);
assert.throws(
  () => checkpointStore.create({
    runId: "checkpoint-invalid",
    agent: "general",
    metadata: {},
    status: "failed",
    startedAt: 10,
    updatedAt: 20,
    attempts: 1,
    events: [],
    checkpoint: { step: 2, messages: [], updatedAt: 21 },
  }),
  /cannot be newer than execution record/,
);
assert.throws(
  () => checkpointStore.create({
    runId: "checkpoint-inflight-invalid",
    agent: "general",
    metadata: {},
    status: "failed",
    startedAt: 10,
    updatedAt: 20,
    attempts: 1,
    events: [],
    checkpoint: { step: -1, messages: [], updatedAt: 20 },
  }),
  /checkpoint step/,
);


assert.throws(() => approvalStore.update("approval-audit-run", {
  approval: { ...approvalRun.approval, status: "pending", decidedAt: 3 },
}), /Pending approval cannot have decidedAt/);

async function assertMutationFencing(store: InMemoryExecutionStore | FileExecutionStore, label: string): Promise<void> {
  const runId = "fencing-" + label;
  const seed = {
    runId,
    agent: "general",
    metadata: {},
    status: "running" as const,
    startedAt: 1,
    updatedAt: 1,
    attempts: 0,
    events: [],
  };
  await store.create(seed);
  const base = Date.now();
  const first = await store.acquireLease!(runId, "worker-a", 100_000, base);
  assert.equal(first?.fencingToken, 1);
  assert.equal(await store.releaseLease!(runId, "worker-a", first!.fencingToken, base + 10), true);
  const second = await store.acquireLease!(runId, "worker-b", 100_000, base + 20);
  assert.equal(second?.fencingToken, 2);

  await assert.rejects(
    async () => { await store.updateFenced!(runId, first!.fencingToken, { error: "stale-write" }); },
    /fencing token is stale/,
  );
  await assert.rejects(
    async () => { await store.transitionFenced!(
      runId,
      first!.fencingToken,
      { status: "waiting" },
      { type: "run.waiting", runId, timestamp: base + 21 },
    ); },
    /fencing token is stale/,
  );

  await store.updateFenced!(runId, second!.fencingToken, { error: "current-write" });
  assert.equal((await store.get(runId))?.error, "current-write");
  assert.equal((await store.get(runId))?.lease?.fencingToken, 2);
}

const fencedMemory = new InMemoryExecutionStore();
await assertMutationFencing(fencedMemory, "memory");

const fencedRoot = await mkdtemp(path.join(os.tmpdir(), "woho-fencing-store-"));
try {
  const fencedFile = new FileExecutionStore({ directory: fencedRoot });
  await assertMutationFencing(fencedFile, "file");
} finally {
  await rm(fencedRoot, { recursive: true, force: true });
}


async function assertMonotonicMutationTimestamps(store: InMemoryExecutionStore | FileExecutionStore, label: string): Promise<void> {
  const runId = "monotonic-" + label;
  await store.create({
    runId,
    agent: "general",
    metadata: {},
    status: "waiting",
    startedAt: 100,
    updatedAt: 500,
    attempts: 1,
    events: [],
    approval: {
      approvalId: "approval-" + label,
      callId: "call-" + label,
      status: "pending",
      tool: "protected",
      capability: "test",
      action: "write",
      requestedAt: 100,
    },
  });
  assert.equal(await store.updateIf!(runId, 500, { updatedAt: 400 }), true);
  assert.equal((await store.get(runId))?.updatedAt, 500);
  assert.equal(await store.resolveApproval!(runId, "approval-" + label, true, undefined, 450), true);
  assert.equal((await store.get(runId))?.updatedAt, 500);
  const lease = await store.acquireLease!(runId, "worker-" + label, 1_000, 450);
  assert.equal(lease?.fencingToken, 1);
  assert.equal((await store.get(runId))?.updatedAt, 500);
  assert.equal(await store.releaseLease!(runId, "worker-" + label, lease!.fencingToken, 450), true);
  assert.equal(await store.cancelExecution!(runId, "cancelled", 450), true);
  assert.equal((await store.get(runId))?.updatedAt, 500);
  assert.equal(await store.acquireLease!(runId, "worker-" + label, 1_000, 450), undefined);
  assert.equal(await store.completeToolExecution!(runId, "call-tool-" + label, "fp-" + label, { status: "completed", result: "ok", updatedAt: 450 }), false);
}

async function assertMonotonicClaimTimestamp(store: InMemoryExecutionStore | FileExecutionStore, label: string): Promise<void> {
  const runId = "claim-monotonic-" + label;
  await store.create({
    runId,
    agent: "general",
    metadata: {},
    status: "queued",
    startedAt: 100,
    updatedAt: 500,
    attempts: 0,
    events: [],
  });
  const claim = await store.claimNextExecution!("worker-" + label, 1_000, { now: 400 });
  assert.equal(claim?.record.updatedAt, 500);
  assert.equal((await store.get(runId))?.updatedAt, 500);
}

const claimMonotonicMemory = new InMemoryExecutionStore();
await assertMonotonicClaimTimestamp(claimMonotonicMemory, "memory");

const claimMonotonicRoot = await mkdtemp(path.join(os.tmpdir(), "woho-claim-monotonic-store-"));
try {
  const claimMonotonicFile = new FileExecutionStore({ directory: claimMonotonicRoot });
  await assertMonotonicClaimTimestamp(claimMonotonicFile, "file");
} finally {
  await rm(claimMonotonicRoot, { recursive: true, force: true });
}

console.log("claim timestamp monotonicity tests passed");

const monotonicMemory = new InMemoryExecutionStore();
await assertMonotonicMutationTimestamps(monotonicMemory, "memory");

const monotonicRoot = await mkdtemp(path.join(os.tmpdir(), "woho-monotonic-store-"));
try {
  const monotonicFile = new FileExecutionStore({ directory: monotonicRoot });
  await assertMonotonicMutationTimestamps(monotonicFile, "file");
} finally {
  await rm(monotonicRoot, { recursive: true, force: true });
}

console.log("monotonic mutation timestamp tests passed");

