import assert from "node:assert/strict";
import { createAI, createMockProvider, createModelRouter, RateLimitError, TimeoutError, type AILogEvent } from "./index.js";
import { AIError } from "./errors.js";

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

const nonCooperative = createAI({
  timeoutMs: 5,
  retries: 0,
  provider: {
    name: "non-cooperative",
    async chat() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { id: "late", text: "late", model: "non-cooperative" };
    },
  },
});
await assert.rejects(nonCooperative.chat({ messages: [{ role: "user", content: "timeout" }] }), (error) => error instanceof TimeoutError);

console.log("core runtime tests passed");


const stalled = createAI({
  timeoutMs: 5,
  retries: 0,
  provider: {
    name: "stalled-stream",
    async chat() { return { id: "x", text: "", model: "stalled-stream" }; },
    async *stream() { await new Promise((resolve) => setTimeout(resolve, 30)); yield { text: "late" }; },
  },
});
const stalledIterator = stalled.stream({ messages: [{ role: "user", content: "stall" }] })[Symbol.asyncIterator]();
await assert.rejects(() => stalledIterator.next(), (error) => error instanceof TimeoutError);
await stalledIterator.return?.();

const abortController = new AbortController();
const aborting = createAI({
  timeoutMs: 1000,
  provider: {
    name: "abort-stream",
    async chat() { return { id: "x", text: "", model: "abort-stream" }; },
    async *stream() { await new Promise((resolve) => setTimeout(resolve, 30)); yield { text: "late" }; },
  },
});
const abortIterator = aborting.stream({ messages: [{ role: "user", content: "abort" }], signal: abortController.signal })[Symbol.asyncIterator]();
const pending = abortIterator.next();
abortController.abort(new Error("user aborted"));
await assert.rejects(() => pending, /user aborted/);
await abortIterator.return?.();

console.log("core streaming timeout tests passed");


const alreadyAborted = new AbortController();
alreadyAborted.abort(new Error("already aborted"));
let chatCalls = 0;
const preAborted = createAI({
  provider: {
    name: "pre-aborted",
    async chat() { chatCalls += 1; return { id: "x", text: "unexpected", model: "pre-aborted" }; },
  },
  timeoutMs: 1000,
});
await assert.rejects(() => preAborted.chat({ messages: [{ role: "user", content: "abort" }], signal: alreadyAborted.signal }), /already aborted/);
assert.equal(chatCalls, 0);

let iteratorReturned = false;
const cleanupStream = createAI({
  timeoutMs: 5,
  provider: {
    name: "cleanup-stream",
    async chat() { return { id: "x", text: "", model: "cleanup-stream" }; },
    stream() {
      const iterator: AsyncIterator<{ text: string }> = {
        async next() {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { done: false, value: { text: "late" } };
        },
        async return() {
          iteratorReturned = true;
          return { done: true, value: undefined };
        },
      };
      return { [Symbol.asyncIterator]: () => iterator };
    },
  },
});
const cleanupIterator = cleanupStream.stream({ messages: [{ role: "user", content: "cleanup" }] })[Symbol.asyncIterator]();
await assert.rejects(() => cleanupIterator.next(), (error) => error instanceof TimeoutError);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(iteratorReturned, true);

const router = createModelRouter({ routes: [{ provider: createMockProvider({ response: "routed" }), models: ["router-test"] }] });
assert.equal((await createAI({ provider: router }).chat({ messages: [{ role: "user", content: "route" }], model: "router-test" })).text, "routed");

await assert.rejects(
  () => createAI({ provider: router }).chat({ messages: [{ role: "user", content: "unknown" }], model: "unconfigured-model" }),
  (error) => error instanceof AIError && error.code === "MODEL_NOT_FOUND",
);

assert.throws(
  () => createModelRouter({ routes: [{ provider: createMockProvider() }], rejectUnknownModel: "yes" as never }),
  /rejectUnknownModel must be a boolean/,
);

assert.equal(
  (await createAI({
    provider: createModelRouter({ routes: [{ provider: createMockProvider({ response: "fallback" }) }], rejectUnknownModel: false }),
  }).chat({ messages: [{ role: "user", content: "legacy" }], model: "unconfigured-model" })).text,
  "fallback",
);


{
  const events: AILogEvent[] = [];
  const provider = createMockProvider();
  const client = createAI({ provider, observability: { onEvent: (event) => { events.push(event); } } });
  await client.chat({
    messages: [{ role: "user", content: "secret prompt", toolCalls: [{ id: "call-1", name: "secret-tool", arguments: "{\"secret\":\"value\"}" }] }],
    tools: [{ name: "secret-tool", description: "private tool", parameters: { secret: true } }],
  });
  const event = events.find((item) => item.type === "request.start");
  assert.equal(event?.type, "request.start");
  assert.equal(event.request.messages[0]?.content, "[REDACTED]");
  assert.equal(event.request.messages[0]?.toolCalls?.[0]?.arguments, "[REDACTED]");
  assert.equal(event.request.tools?.[0]?.description, "[REDACTED]");
}

{
  const events: AILogEvent[] = [];
  const provider = createMockProvider();
  const client = createAI({ provider, includeRequestContentInObservability: true, observability: { onEvent: (event) => { events.push(event); } } });
  await client.chat({ messages: [{ role: "user", content: "visible prompt" }] });
  const event = events.find((item) => item.type === "request.start");
  assert.equal(event?.type, "request.start");
  assert.equal(event.request.messages[0]?.content, "visible prompt");
}

{
  assert.throws(() => createAI({ provider: createMockProvider(), includeRequestContentInObservability: "yes" as never }), /must be a boolean/);
}
