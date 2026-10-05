import assert from "node:assert/strict";
import { createInMemoryStore } from "./index.js";

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
  console.log("memory runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
