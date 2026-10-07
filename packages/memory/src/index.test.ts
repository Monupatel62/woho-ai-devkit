import assert from "node:assert/strict";
import { createInMemoryStore, createJsonFileStore, createConversation, searchMemorySemantic, summarizeMemory, summarizeMemoryWith } from "./index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { searchMemory } from "./search.js";
import { tmpdir } from "node:os";
import { symlink, utimes, writeFile } from "node:fs/promises";

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
  assert.throws(() => createInMemoryStore({ maxMetadataBytes: 0 }), /maxMetadataBytes/);
  assert.throws(() => createInMemoryStore({ maxMetadataDepth: 0 }), /maxMetadataDepth/);
  const oversizedMetadataStore = createInMemoryStore({ maxMetadataBytes: 50 });
  const oversizedMetadata = { secret: "x".repeat(100) };
  await assert.rejects(
    () => oversizedMetadataStore.add({ id: "oversized-meta", role: "user", content: "x", metadata: oversizedMetadata }),
    /maxMetadataBytes/,
  );
  const deepMetadata = { level: { level: { level: { value: true } } } };
  await assert.rejects(
    () => createInMemoryStore({ maxMetadataDepth: 2 }).add({ id: "deep-meta", role: "user", content: "x", metadata: deepMetadata }),
    /maxMetadataDepth/,
  );
  const circularMetadata: Record<string, unknown> = {};
  circularMetadata.self = circularMetadata;
  await assert.rejects(
    () => store.add({ id: "circular-meta", role: "user", content: "x", metadata: circularMetadata }),
    /circular references/,
  );
  await assert.rejects(() => store.add({ id: "bad-role", role: "invalid" as never, content: "x" }), /role is invalid/);
  await assert.rejects(() => store.add(null as never), /message is required/);
  await assert.rejects(() => store.add({ id: "bad-time", role: "user", content: "x", timestamp: Number.NaN }), /timestamp must be finite/);
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
  const fileStore = createJsonFileStore({ filePath: join(dir, "memory.json"), maxMessages: 10, maxFileBytes: 1024 });
  assert.throws(() => createJsonFileStore({ filePath: join(dir, "x.json"), maxFileBytes: 0 }), /positive integer/);
  assert.throws(() => createJsonFileStore({ filePath: join(dir, "meta.json"), maxMetadataBytes: 0 }), /maxMetadataBytes/);
  assert.throws(() => createJsonFileStore({ filePath: join(dir, "meta-depth.json"), maxMetadataDepth: 0 }), /maxMetadataDepth/);
  const boundedMetadataStore = createJsonFileStore({ filePath: join(dir, "bounded-meta.json"), maxMetadataBytes: 50 });
  await assert.rejects(
    () => boundedMetadataStore.add({ id: "meta", role: "user", content: "x", metadata: { payload: "x".repeat(100) } }),
    /maxMetadataBytes/,
  );
  const boundedStore = createJsonFileStore({ filePath: join(dir, "bounded.json"), maxFileBytes: 40 });
  await assert.rejects(() => boundedStore.add({ id: "large", role: "user", content: "x".repeat(100) }), /exceeds maxFileBytes/);
  const symlinkTarget = join(dir, "symlink-target.json");
  const symlinkPath = join(dir, "symlink.json");
  await writeFile(symlinkTarget, JSON.stringify([{ id: "outside", role: "user", content: "outside" }]));
  await symlink(symlinkTarget, symlinkPath);
  const symlinkStore = createJsonFileStore({ filePath: symlinkPath });
  await assert.rejects(() => symlinkStore.list(), /not a regular file/);

  const persistentA = createConversation({ sessionId: "a", store: fileStore });
  const persistentB = createConversation({ sessionId: "b", store: fileStore });
  await persistentA.add({ id: "pa", role: "user", content: "private a" });
  await persistentB.add({ id: "pb", role: "user", content: "private b" });
  await persistentA.clear();
  assert.equal((await persistentA.messages()).length, 0);
  assert.equal((await persistentB.messages()).length, 1);

  await fileStore.add({ id: "c", role: "user", content: "three", timestamp: 3 });
  assert.deepEqual((await fileStore.list()).map((m) => m.id), ["pb", "c"]);
  await assert.rejects(() => fileStore.list({ before: Number.NaN }), /finite number/);
  const sharedPath = join(dir, "shared.json");
  const sharedA = createJsonFileStore({ filePath: sharedPath });
  const sharedB = createJsonFileStore({ filePath: sharedPath });
  await Promise.all([
    sharedA.add({ id: "shared-a", role: "user", content: "a" }),
    sharedB.add({ id: "shared-b", role: "user", content: "b" }),
  ]);
  assert.deepEqual((await sharedA.list()).map((m) => m.id).sort(), ["shared-a", "shared-b"]);

  assert.throws(() => createJsonFileStore({ filePath: join(dir, "invalid-lock.json"), lockTimeoutMs: 0 }), /lockTimeoutMs/);
  assert.throws(() => createJsonFileStore({ filePath: join(dir, "invalid-lock.json"), lockRetryMs: 0 }), /lockRetryMs/);
  assert.throws(() => createJsonFileStore({ filePath: join(dir, "invalid-lock.json"), lockStaleMs: 1, lockRetryMs: 25 }), /lockStaleMs/);

  const lockedPath = join(dir, "locked.json");
  const lockedStore = createJsonFileStore({ filePath: lockedPath, lockTimeoutMs: 30, lockRetryMs: 5, lockStaleMs: 1000 });
  await writeFile(lockedPath + ".lock", "active", { mode: 0o600 });
  await assert.rejects(() => lockedStore.add({ id: "locked", role: "user", content: "x" }), /lock acquisition timed out/);
  await rm(lockedPath + ".lock", { force: true });

  const liveStalePath = join(dir, "live-stale.json");
  const liveStaleStore = createJsonFileStore({ filePath: liveStalePath, lockTimeoutMs: 40, lockRetryMs: 5, lockStaleMs: 20 });
  await writeFile(liveStalePath + ".lock", JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }), { mode: 0o600 });
  const liveOld = new Date(Date.now() - 1000);
  await utimes(liveStalePath + ".lock", liveOld, liveOld);
  await assert.rejects(() => liveStaleStore.add({ id: "live-stale", role: "user", content: "must-not-steal" }), /lock acquisition timed out/);
  await rm(liveStalePath + ".lock", { force: true });

  const stalePath = join(dir, "stale.json");
  const staleStore = createJsonFileStore({ filePath: stalePath, lockTimeoutMs: 100, lockRetryMs: 5, lockStaleMs: 20 });
  await writeFile(stalePath + ".lock", "stale", { mode: 0o600 });
  const old = new Date(Date.now() - 1000);
  await utimes(stalePath + ".lock", old, old);
  await staleStore.add({ id: "stale", role: "user", content: "recovered" });
  assert.equal((await staleStore.list())[0]?.id, "stale");

  await fileStore.clear();
  assert.equal((await fileStore.list()).length, 0);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(dir, "invalid.json"), JSON.stringify([{ id: "", role: "user", content: "bad" }])));
  const invalidStore = createJsonFileStore({ filePath: join(dir, "invalid.json") });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(dir, "bad-role.json"), JSON.stringify([{ id: "x", role: "invalid", content: "bad" }])));
  const badRoleStore = createJsonFileStore({ filePath: join(dir, "bad-role.json") });
  await assert.rejects(() => badRoleStore.list(), /invalid message/);
  await assert.rejects(() => invalidStore.list(), /invalid message/);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(dir, "queue.json"), JSON.stringify([{ id: "", role: "user", content: "bad" }])));
  const queueStore = createJsonFileStore({ filePath: join(dir, "queue.json") });
  await assert.rejects(() => queueStore.add({ id: "ok", role: "user", content: "ok" }), /invalid message/);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(dir, "queue.json"), "[]"));
  await queueStore.add({ id: "ok2", role: "user", content: "ok2" });
  assert.deepEqual((await queueStore.list()).map((m) => m.id), ["ok2"]);

  const rankedStore = createInMemoryStore();
  await rankedStore.add({ id: "r1", role: "user", content: "TypeScript and Python" });
  await rankedStore.add({ id: "r2", role: "user", content: "TypeScript only" });
  const ranked = await searchMemory(rankedStore, "typescript python", { limit: 5 });
  assert.equal(ranked[0]?.message.id, "r1");
  assert.equal(ranked[0]?.score, 2);
  await assert.rejects(
    () => searchMemory(rankedStore, "x".repeat(20), { maxQueryCharacters: 10 }),
    /exceeds maxQueryCharacters/,
  );
  const boundedRanked = await searchMemory(rankedStore, "typescript", { maxMessages: 1 });
  assert.equal(boundedRanked.length, 1);
  assert.equal(boundedRanked[0]?.message.id, "r2");
  const summary = summarizeMemory([{ id: "s", role: "user", content: "hello world" }], { maxCharacters: 50 });
  assert.equal(summary.role, "system");
  assert.ok(summary.content.includes("hello world"));
  const aiSummary = await summarizeMemoryWith({ summarize: async () => "AI summary" }, [{ id: "s", role: "user", content: "hello" }], { maxCharacters: 50 });
  assert.equal(aiSummary.content, "AI summary");
  await assert.rejects(() => summarizeMemoryWith({ summarize: async () => "x" }, [], { maxCharacters: 0 }), /positive integer/);
  assert.throws(() => summarizeMemory([{ id: "s", role: "user", content: "x" }], { maxCharacters: 0 }), /positive integer/);
  assert.throws(() => createConversation({ sessionId: "", store: createInMemoryStore() }), /sessionId/);
  const semantic = await searchMemorySemantic(
    [
      { id: "v1", role: "user", content: "alpha beta" },
      { id: "v2", role: "user", content: "gamma delta" },
    ],
    "alpha",
    { embed: async (text) => text.includes("alpha") ? [1, 0] : [0, 1] },
  );
  assert.equal(semantic[0]?.message.id, "v1");
  assert.equal(semantic[0]?.score, 1);
  await assert.rejects(
    () => searchMemorySemantic([{ id: "v1", role: "user", content: "alpha" }, { id: "v2", role: "user", content: "beta" }], "alpha", { embed: async () => [1, 0] }, { maxMessages: 1 }),
    /exceeds maxMessages/,
  );
  await assert.rejects(
    () => searchMemorySemantic([{ id: "v1", role: "user", content: "alpha" }], "alpha", { embed: async () => [1, 0] }, { maxTextCharacters: 3 }),
    /exceeds maxTextCharacters/,
  );
  await rm(dir, { recursive: true, force: true });
  console.log("memory runtime tests passed");
};

run().catch((error) => { console.error(error); process.exitCode = 1; });
