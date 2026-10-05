import assert from "node:assert/strict";
import { createAI, createMockProvider, RateLimitError, TimeoutError } from "./index.js";

const requestEvents: string[] = [];
const ai = createAI({
  provider: createMockProvider({ response: "ok" }),
  observability: { onEvent: async (event) => { requestEvents.push(event.type); } },
});
const result = await ai.chat({ messages: [{ role: "user", content: "hello" }] });
assert.equal(result.text, "ok");
assert.deepEqual(requestEvents, ["request.start", "request.success"]);

const streamEvents: string[] = [];
const streaming = createAI({
  provider: createMockProvider({ response: "hello world" }),
  observability: { onEvent: (event) => { streamEvents.push(event.type); } },
});
const chunks: string[] = [];
for await (const chunk of streaming.stream({ messages: [{ role: "user", content: "hello" }] })) chunks.push(chunk.text);
assert.equal(chunks.join(""), "hello world ");
assert.equal(streamEvents[0], "stream.start");
assert.equal(streamEvents.at(-1), "stream.end");
assert.ok(streamEvents.includes("stream.chunk"));

assert.throws(() => createAI({ provider: createMockProvider(), timeoutMs: 0 }), /timeoutMs must be a positive integer/);
assert.throws(() => createAI({ provider: createMockProvider(), retries: -1 }), /retries must be a non-negative integer/);
assert.throws(() => createAI({ provider: createMockProvider(), retryDelayMs: -1 }), /retryDelayMs must be a non-negative integer/);

const tooMany = Array.from({ length: 101 }, (_, index) => ({ role: "user" as const, content: String(index) }));
await assert.rejects(ai.chat({ messages: tooMany }), /AI request exceeds maxMessages/);

let attempts = 0;
const retrying = createAI({
  retries: 2,
  retryDelayMs: 1,
  provider: {
    name: "retry-test",
    async chat() {
      attempts += 1;
      if (attempts < 3) throw new RateLimitError("retry");
      return { id: "ok", text: "recovered", model: "retry-test", finishReason: "stop" };
    },
  },
});
assert.equal((await retrying.chat({ messages: [{ role: "user", content: "retry" }] })).text, "recovered");
assert.equal(attempts, 3);

const timedOut = createAI({
  timeoutMs: 5,
  retries: 0,
  provider: {
    name: "timeout-test",
    async chat() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { id: "late", text: "late", model: "timeout-test" };
    },
  },
});
await assert.rejects(timedOut.chat({ messages: [{ role: "user", content: "slow" }] }), (error) => error instanceof TimeoutError);

console.log("core runtime tests passed");
