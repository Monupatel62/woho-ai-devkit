import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InMemoryExecutionStore, FileExecutionStore, type ExecutionRecord } from "./execution-store.js";

const makeRecord = (runId: string): ExecutionRecord => ({
  runId, agent: "approval-race", input: "x", metadata: {}, status: "waiting",
  startedAt: 1, updatedAt: 10, attempts: 1, events: [],
  approval: { approvalId: "approval-1", callId: "call-1", inputFingerprint: "a".repeat(64), status: "pending", tool: "protected", capability: "filesystem", action: "write", requestedAt: 10 },
});

async function check(store: InMemoryExecutionStore | FileExecutionStore): Promise<void> {
  await store.create(makeRecord("cancelled-approval"));
  assert.equal(await store.cancelExecution!("cancelled-approval", "cancelled", 20), true);
  assert.equal(await store.resolveApproval("cancelled-approval", "approval-1", true, "late approval", 21), false);
  const record = await store.get("cancelled-approval");
  assert.equal(record?.status, "cancelled");
  assert.equal(record?.approval?.status, "pending");
}

await check(new InMemoryExecutionStore());
const root = await mkdtemp(path.join(os.tmpdir(), "woho-approval-race-"));
try { await check(new FileExecutionStore({ directory: root })); } finally { await rm(root, { recursive: true, force: true }); }
console.log("cancelled approval race tests passed");
