import assert from "node:assert/strict";
import { InMemoryExecutionStore, FileExecutionStore, type ExecutionRecord } from "./execution-store.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function seed(runId: string): ExecutionRecord {
  return {
    runId,
    projectId: "project-a",
    agent: "general",
    input: "original-input",
    parentRunId: "parent-a",
    sessionId: "session-a",
    metadata: {},
    status: "running",
    startedAt: 10,
    updatedAt: 10,
    attempts: 0,
    events: [],
  };
}

async function expectBlocked(operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), /identity field cannot be mutated/);
    return;
  }
  assert.fail("Expected execution identity mutation to be rejected");
}

async function exercise(store: InMemoryExecutionStore | FileExecutionStore): Promise<void> {
  const runId = "immutable-identity";
  await store.create(seed(runId));
  const lease = await store.acquireLease!(runId, "worker-a", 10_000, 20);
  assert.ok(lease);

  const patches: Array<Partial<ExecutionRecord>> = [
    { runId: "different-run" },
    { projectId: "project-b" },
    { agent: "different-agent" },
    { input: "tampered-input" },
    { parentRunId: "different-parent" },
    { sessionId: "different-session" },
    { startedAt: 999 },
  ];

  for (const patch of patches) {
    await expectBlocked(() => store.update(runId, patch));
    assert.equal(await store.updateIf!(runId, 20, patch), false);
    await expectBlocked(() => store.updateFenced!(runId, lease!.fencingToken, patch));
    await expectBlocked(() => store.transition!(runId, patch, {
      type: "run.waiting",
      runId,
      timestamp: 20,
    }));
    await expectBlocked(() => store.transitionFenced!(runId, lease!.fencingToken, patch, {
      type: "run.waiting",
      runId,
      timestamp: 20,
    }));
  }

  const current = await store.get(runId);
  assert.equal(current?.runId, runId);
  assert.equal(current?.projectId, "project-a");
  assert.equal(current?.sessionId, "session-a");
  assert.equal(current?.parentRunId, "parent-a");
  assert.equal(current?.agent, "general");
  assert.equal(current?.input, "original-input");
  assert.equal(current?.startedAt, 10);
}

const memory = new InMemoryExecutionStore();
await exercise(memory);



console.log("immutable execution identity tests passed");
