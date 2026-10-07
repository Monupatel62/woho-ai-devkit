import assert from "node:assert/strict";
import { AgentExecutionWorker } from "./worker.js";
import { InMemoryExecutionStore, type ExecutionRecord } from "./execution-store.js";

const record = (runId: string, status: ExecutionRecord["status"] = "queued"): ExecutionRecord => ({
  runId, projectId: "chaos-project", agent: "chaos", input: "chaos", metadata: {},
  status, startedAt: 1, updatedAt: 1, attempts: 0, events: [],
});

async function testCrashBeforeCompletionIsRecoverable(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(record("crash"));
  const first = new AgentExecutionWorker(store, { workerId: "dead", leaseTtlMs: 10, heartbeatIntervalMs: 5 });
  const claim = await store.claimExecution!("crash", "dead", 10, 100);
  assert.equal(claim?.lease.fencingToken, 1);
  // Simulate process death: no release/terminal mutation.
  const recovered = new AgentExecutionWorker(store, { workerId: "recovered", leaseTtlMs: 1000, heartbeatIntervalMs: 100 });
  let sawRecovery = false;
  const outcome = await recovered.runOnce(async (_r, context) => { sawRecovery = context.recovered; });
  assert.equal(outcome?.status, "succeeded");
  assert.equal(sawRecovery, true);
  assert.equal(store.get("crash")?.status, "succeeded");
  void first;
}

async function testExpiredWorkerCannotFinalizeAfterRecovery(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(record("fence-chaos"));
  const base = Date.now();
  const a = await store.claimExecution!("fence-chaos", "worker-a", 10, base);
  const b = await store.claimExecution!("fence-chaos", "worker-b", 1000, base + 100);
  assert.ok(a && b);
  assert.equal(b.lease.fencingToken, 2);
  await assert.rejects(() => Promise.resolve().then(() => store.updateFenced!("fence-chaos", a.lease.fencingToken, { status: "failed", error: "stale" })), /fencing token is stale/);
  await store.updateFenced!("fence-chaos", b.lease.fencingToken, { status: "succeeded", completedAt: 201 });
  assert.equal(store.get("fence-chaos")?.status, "succeeded");
}

async function testCancellationWinsRaceWithWorkerCompletion(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(record("cancel-race"));
  const worker = new AgentExecutionWorker(store, { workerId: "race", leaseTtlMs: 1000, heartbeatIntervalMs: 10 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const running = worker.runOnce(async () => blocked);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.cancelExecution!("cancel-race", "user cancelled", 50), true);
  release();
  const outcome = await running;
  assert.equal(outcome?.status, "lease_lost");
  assert.equal(store.get("cancel-race")?.status, "cancelled");
}

async function testRetryNeverDuplicatesClaimedWork(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(record("retry-side-effect"));
  const worker = new AgentExecutionWorker(store, { workerId: "retry", leaseTtlMs: 1000, heartbeatIntervalMs: 10, maxAttempts: 2 });
  let effects = 0;
  const first = await worker.runOnce(async () => { effects += 1; throw new Error("transient"); });
  assert.equal(first?.status, "queued");
  const second = await worker.runOnce(async () => { effects += 1; });
  assert.equal(second?.status, "succeeded");
  assert.equal(effects, 2);
  assert.equal(store.get("retry-side-effect")?.attempts, 2);
}

async function testProjectQueueIsolationDuringChaos(): Promise<void> {
  const store = new InMemoryExecutionStore();
  await store.create(record("project-a-1"));
  await store.create({ ...record("project-b-1"), projectId: "other-project" });
  const worker = new AgentExecutionWorker(store, { workerId: "project-a-worker", leaseTtlMs: 1000, heartbeatIntervalMs: 10, projectId: "chaos-project" });
  const outcome = await worker.runOnce(async () => {});
  assert.equal(outcome?.runId, "project-a-1");
  assert.equal(store.get("project-b-1")?.status, "queued");
}

await testCrashBeforeCompletionIsRecoverable();
await testExpiredWorkerCannotFinalizeAfterRecovery();
await testCancellationWinsRaceWithWorkerCompletion();
await testRetryNeverDuplicatesClaimedWork();
await testProjectQueueIsolationDuringChaos();
console.log("chaos tests passed");
