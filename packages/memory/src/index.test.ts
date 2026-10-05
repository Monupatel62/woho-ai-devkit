import assert from "node:assert/strict";
import { createInMemoryStore, createJsonFileStore, createConversation, summarizeMemory, summarizeMemoryWith } from "./index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  await assert.rejects(() => store.list({ before: Number.NaN }), /finite number/);
  await assert.rejects(() => store.list({ sessionId: " " }), /sessionId cannot be empty/);

  const sessionStore = createInMemoryStore();
  const conversation = createConversation({ sessionId: "s1", store: sessionStore });
  await conversation.add({ id: "m1", role: "user", content: "How does TypeScript work?" });
  await conversation.add({ id: "m2", role: "assistant", content: "TypeScript adds types to JavaScript." });
  await conversation.add({ id: "m3", role: "user", content: "Tell me about Python instead." });
  const other = createConversation({ sessionId: "s2", store: sessionStore });
  await other.add({ id: "other", role: "user", content: "typescript from another session" });
  assert.equal((await conversation.messages()).length, 3);
  assert.equal((await other.messages()).length, 1);
  assert.equal((await conversation.search({ query: "typescript" })).length, 2);
  await conversation.clear();
  assert.equal((await conversation.messages()).length, 0);
  assert.equal((await other.messages()).length, 1);

  const dir = await mkdtemp(join(tmpdir(), "woho-memory-"));
  const fileStore = createJsonFileStore({ filePath: join(dir, "memory.json"), maxMessages: 10 });
  const persistentA = createConversation({ sessionId: "a", store: fileStore });
  const persistentB = createConversation({ sessionId: "b", store: fileStore });
  await persistentA.add({ id: "pa", role: "user", content: "private a" });
  await persistentB.add({ id: "pb", role: "user", content: "private b" });
  await persistentA.clear();
  assert.equal((await persistentA.messages()).length, 0);
  assert.equal((await persistentB.messages()).length, 1);

  await fileStore.add({ id: "c", role: "user", content: "three", timestamp: 3 });
  assert.deepEqual((await fileStore.list()).map((m) => m.id), ["pb", "c"]);
  await fileStore.clear();
  assert.equal((await fileStore.list()).length, 0);

  const summary = summarizeMemory([{ id: "s", role: "user", content: "hello world" }], { maxCharacters: 50 });
  assert.equal(summary.role, "system");
  assert.ok(summary.content.includes("hello world"));
  const aiSummary = await summarizeMemoryWith({ summarize: async () => "AI summary" }, [{ id: "s", role: "user", content: "hello" }], { maxCharacters: 50 });
  assert.equal(aiSummary.content, "AI summary");
  await assert.rejects(() => summarizeMemoryWith({ summarize: async () => "x" }, [], { maxCharacters: 0 }), /positive integer/);
  assert.throws(() => summarizeMemory([{ id: "s", role: "user", content: "x" }], { maxCharacters: 0 }), /positive integer/);
  assert.throws(() => createConversation({ sessionId: "", store: createInMemoryStore() }), /sessionId/);
  await rm(dir, { recursive: true, force: true });
  console.log("memory runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
