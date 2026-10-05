import assert from "node:assert/strict";
import { createInMemoryStore, createJsonFileStore } from "./index.js";\nimport { mkdtemp, rm } from "node:fs/promises";\nimport { join } from "node:path";\nimport { tmpdir } from "node:os";

const run = async () => {
  const store = createInMemoryStore({ maxMessages: 2 });
  await store.add({ id: "1", role: "user", content: "hello", timestamp: 1 });
  await store.add({ id: "2", role: "assistant", content: "hi", timestamp: 2 });
  await store.add({ id: "3", role: "user", content: "again", timestamp: 3 });
  assert.deepEqual((await store.list()).map((m) => m.id), ["2", "3"]);
  assert.deepEqual((await store.list({ limit: 1 })).map((m) => m.id), ["3"]);
  assert.deepEqual((await store.list({ before: 3 })).map((m) => m.id), ["2"]);
  await store.clear();
  assert.equal((await store.list()).length, 0);
  assert.throws(() => createInMemoryStore({ maxMessages: 0 }), /positive integer/);
  const dir = await mkdtemp(join(tmpdir(), "woho-memory-"));
  const fileStore = createJsonFileStore({ filePath: join(dir, "memory.json"), maxMessages: 2 });
  await fileStore.add({ id: "a", role: "user", content: "one", timestamp: 1 });
  await fileStore.add({ id: "b", role: "assistant", content: "two", timestamp: 2 });
  await fileStore.add({ id: "c", role: "user", content: "three", timestamp: 3 });
  assert.deepEqual((await fileStore.list()).map((m) => m.id), ["b", "c"]);
  await fileStore.clear();
  assert.equal((await fileStore.list()).length, 0);
  await rm(dir, { recursive: true, force: true });
  console.log("memory runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
