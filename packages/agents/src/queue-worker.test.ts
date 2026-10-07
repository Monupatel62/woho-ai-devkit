import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentExecutionWorker } from "./worker.js";
import { FileExecutionStore, InMemoryExecutionStore, type ExecutionRecord } from "./execution-store.js";

const makeRecord = (runId: string, projectId = "project-a", status: ExecutionRecord["status"] = "queued"): ExecutionRecord => ({
  runId,
  projectId,
  agent: "worker-test",
  input: "work",
  metadata: {},
  status,
  startedAt: 1,
  updatedAt: 1,
  attempts: 0,
  events: [],
});

async function testMemoryWorker(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(makeRecord("a"));
  await store.create(makeRecord("b"));
  await store.create(makeRecord("other", "project-b"));

  const workerA = new AgentExecutionWorker(store, { workerId: "worker-a", leaseTtlMs: 1000, heartbeatIntervalMs: 100, projectId: "project-a" });
  const workerB = new AgentExecutionWorker(store, { workerId: "worker-b", leaseTtlMs: 1000, heartbeatIntervalMs: 100, projectId: "project-a" });
  let executions = 0;
  const handler = async () => { executions += 1; };

  const raced = await Promise.all([workerA.runOnce(handler), workerB.runOnce(handler)]);
  assert.equal(raced.filter(Boolean).length, 2);
  assert.equal(executions, 2);
  assert.equal(store.get("a")?.status, "succeeded");
  assert.equal(store.get("b")?.status, "succeeded");
  assert.equal(store.get("other")?.status, "queued");

  const empty = await workerA.runOnce(handler);
  assert.equal(empty, undefined);

  await store.create(makeRecord("same-worker"));
  let concurrentExecutions = 0;
  const slowHandler = async () => {
    concurrentExecutions += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const sameWorker = new AgentExecutionWorker(store, { workerId: "same-worker", leaseTtlMs: 1000, heartbeatIntervalMs: 100 });
  const sameWorkerResults = await Promise.all([sameWorker.runOnce(slowHandler), sameWorker.runOnce(slowHandler)]);
  assert.equal(sameWorkerResults.filter(Boolean).length, 1);
  assert.equal(concurrentExecutions, 1);
}

async function testRetryAndBackoff(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(makeRecord("retry"));
  const worker = new AgentExecutionWorker(store, {
    workerId: "retry-worker",
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 100,
    maxAttempts: 3,
    retryDelayMs: 10_000,
  });
  let calls = 0;
  const first = await worker.runOnce(async () => {
    calls += 1;
    throw new Error("temporary failure");
  });
  assert.equal(first?.status, "queued");
  assert.equal(store.get("retry")?.attempts, 1);
  assert.equal(store.get("retry")?.availableAt !== undefined, true);
  assert.equal(calls, 1);
  assert.equal(await worker.runOnce(async () => { calls += 1; }), undefined);
}

async function testRetryThenSuccess(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(makeRecord("retry-success"));
  const worker = new AgentExecutionWorker(store, {
    workerId: "retry-success-worker",
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 100,
    maxAttempts: 2,
  });
  let calls = 0;
  const handler = async () => {
    calls += 1;
    if (calls === 1) throw new Error("retry me");
  };
  const first = await worker.runOnce(handler);
  assert.equal(first?.status, "queued");
  const second = await worker.runOnce(handler);
  assert.equal(second?.status, "succeeded");
  assert.equal(store.get("retry-success")?.attempts, 2);
  assert.equal(calls, 2);
}

async function testCrashRecoveryAndFencing(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(makeRecord("crashed", "project-a", "running"));
  const first = await store.acquireLease!("crashed", "dead-worker", 10, 100);
  assert.equal(first?.fencingToken, 1);

  const recoveredWorker = new AgentExecutionWorker(store, {
    workerId: "recovery-worker",
    leaseTtlMs: 1000,
    heartbeatIntervalMs: 100,
  });
  let recovered = false;
  const outcome = await recoveredWorker.runOnce(async (_record, context) => {
    recovered = context.recovered;
  });
  assert.equal(outcome?.status, "succeeded");
  assert.equal(recovered, true);
  assert.equal(store.get("crashed")?.attempts, 1);
  assert.equal(store.get("crashed")?.status, "succeeded");

  await store.create(makeRecord("fence"));
  const claimA = await store.claimExecution!("fence", "worker-a", 10, 100);
  assert.ok(claimA);
  const claimB = await store.claimExecution!("fence", "worker-b", 1000, 200);
  assert.ok(claimB);
  assert.equal(claimB?.lease.fencingToken, 2);
  await assert.rejects(
    () => Promise.resolve().then(() => store.transitionFenced!("fence", claimA!.lease.fencingToken, { status: "succeeded" }, {
      type: "run.completed",
      runId: "fence",
      timestamp: 201,
      data: { eventId: "stale-worker" },
    })),
    /fencing token is stale/,
  );
}

async function testDurableCancellation(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(makeRecord("cancel"));
  const worker = new AgentExecutionWorker(store, {
    workerId: "cancel-worker",
    leaseTtlMs: 40,
    heartbeatIntervalMs: 10,
  });
  let observedAbort = false;
  const outcomePromise = worker.runOnce(async (_record, context) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      context.signal.addEventListener("abort", () => {
        observedAbort = true;
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.cancelExecution!("cancel", "owner requested cancellation", 10), true);
  const outcome = await outcomePromise;
  assert.equal(observedAbort, true);
  assert.equal(outcome?.status, "lease_lost");
  assert.equal(store.get("cancel")?.status, "cancelled");
  assert.equal(await store.cancelExecution!("cancel", "duplicate cancellation", 20), false);
}

async function testFileWorkerRace(): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "woho-queue-worker-"));
  try {
    const store = new FileExecutionStore({ directory: root });
    await store.create(makeRecord("file-a"));
    await store.create(makeRecord("file-b"));
    const workerA = new AgentExecutionWorker(store, { workerId: "file-a-worker", leaseTtlMs: 1000, heartbeatIntervalMs: 100 });
    const workerB = new AgentExecutionWorker(store, { workerId: "file-b-worker", leaseTtlMs: 1000, heartbeatIntervalMs: 100 });
    const claimed: string[] = [];
    const handler = async (record: ExecutionRecord) => { claimed.push(record.runId); };
    const outcomes = await Promise.all([workerA.runOnce(handler), workerB.runOnce(handler)]);
    assert.equal(outcomes.filter(Boolean).length, 2);
    assert.deepEqual([...claimed].sort(), ["file-a", "file-b"]);
    assert.equal((await store.get("file-a"))?.status, "succeeded");
    assert.equal((await store.get("file-b"))?.status, "succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await testMemoryWorker();
await testRetryAndBackoff();
await testRetryThenSuccess();
await testCrashRecoveryAndFencing();
await testDurableCancellation();
await testFileWorkerRace();
console.log("queue worker tests passed");
