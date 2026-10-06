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

{
  const events: AILogEvent[] = [];
  const client = createAI({
    provider: {
      name: "secret-stream-provider",
      async chat() { return { id: "x", text: "", model: "secret-stream-provider" }; },
      async *stream() { yield { id: "chunk-1", text: "secret streamed output", model: "secret-stream-provider" }; },
    },
    observability: { onEvent: (event) => { events.push(event); } },
  });
  const chunks: string[] = [];
  for await (const chunk of client.stream({ messages: [{ role: "user", content: "x" }] })) chunks.push(chunk.text);
  assert.deepEqual(chunks, ["secret streamed output"]);
  const event = events.find((item) => item.type === "stream.chunk");
  assert.equal(event?.type, "stream.chunk");
  assert.equal(event.chunk.text, "[REDACTED]");
  assert.ok(!JSON.stringify(event).includes("secret streamed output"));
}

{
  const events: AILogEvent[] = [];
  const client = createAI({
    provider: {
      name: "visible-stream-provider",
      async chat() { return { id: "x", text: "", model: "visible-stream-provider" }; },
      async *stream() { yield { id: "chunk-1", text: "visible streamed output", model: "visible-stream-provider" }; },
    },
    includeRequestContentInObservability: true,
    observability: { onEvent: (event) => { events.push(event); } },
  });
  for await (const _chunk of client.stream({ messages: [{ role: "user", content: "x" }] })) {}
  const event = events.find((item) => item.type === "stream.chunk");
  assert.equal(event?.type, "stream.chunk");
  assert.equal(event.chunk.text, "visible streamed output");
}


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
  const provider = {
    name: "secret-response-provider",
    async chat() { return { id: "response-1", model: "secret-response-provider", text: "secret model output", toolCalls: [{ id: "call-1", name: "secret-tool", arguments: "{\"token\":\"secret\"}" }] }; },
  };
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
  const success = events.find((item) => item.type === "request.success");
  assert.equal(success?.type, "request.success");
  assert.equal(success.response.text, "[REDACTED]");
  assert.equal(success.response.toolCalls?.[0]?.arguments, "[REDACTED]");
  assert.ok(!JSON.stringify(success).includes("secret model output"));
  assert.ok(!JSON.stringify(success).includes('{"token":"secret"}'));
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
  const events: AILogEvent[] = [];
  const client = createAI({
    provider: {
      name: "secret-error-provider",
      async chat() { throw new Error("provider secret: sk-live-super-secret"); },
    },
    retries: 0,
    observability: { onEvent: (event) => { events.push(event); } },
  });
  await assert.rejects(() => client.chat({ messages: [{ role: "user", content: "x" }] }));
  const event = events.find((item) => item.type === "request.error");
  assert.equal(event?.type, "request.error");
  assert.deepEqual(event.error, { name: "Error" });
  assert.ok(!JSON.stringify(event).includes("sk-live-super-secret"));
}

{
  assert.throws(() => createAI({ provider: createMockProvider(), includeRequestContentInObservability: "yes" as never }), /must be a boolean/);
}


await assert.rejects(
  () => ai.chat({
    messages: [{ role: "user", content: "x" }],
    tools: Array.from({ length: 65 }, (_, index) => ({ name: "tool-" + index, description: "tool" })),
  }),
  /AI request exceeds maxToolDefinitions/,
);

await assert.rejects(
  () => ai.chat({
    messages: [{ role: "user", content: "x", toolCalls: [{ id: "call-1", name: "tool", arguments: "x".repeat(256 * 1024 + 1) }] }],
  }),
  /AI tool call exceeds maxToolArgumentBytes/,
);

await assert.rejects(
  () => ai.chat({
    messages: [{
      role: "user",
      content: "x",
      toolCalls: Array.from({ length: 33 }, (_, index) => ({ id: "call-" + index, name: "tool", arguments: "{}" })),
    }],
  }),
  /AI message exceeds maxToolCallsPerMessage/,
);

await assert.rejects(
  () => ai.chat({
    messages: [{ role: "user", content: "x" }],
    tools: [{ name: "tool", description: "x".repeat(256 * 1024) }],
  }),
  /AI request exceeds maxToolDefinitionBytes/,
);

console.log("core request resource-bound tests passed");


await assert.rejects(
  () => ai.chat({ messages: [{ role: "user", content: "x" }], temperature: 2.1 }),
  /temperature must be a finite number between 0 and 2/,
);
await assert.rejects(
  () => ai.chat({ messages: [{ role: "user", content: "x" }], topP: 0 }),
  /topP must be a finite number greater than 0 and at most 1/,
);
await assert.rejects(
  () => ai.chat({ messages: [{ role: "user", content: "x" }], maxTokens: 0 }),
  /maxTokens must be a positive integer/,
);
await assert.rejects(
  () => ai.chat({ messages: [{ role: "user", content: "x" }], stop: Array.from({ length: 17 }, () => "stop") }),
  /AI request exceeds maxStopSequences/,
);
await assert.rejects(
  () => ai.chat({ messages: [{ role: "user", content: "x" }], stop: ["x".repeat(4097)] }),
  /AI stop sequence exceeds maxStopSequenceCharacters/,
);
await assert.rejects(
  () => ai.chat({ messages: [{ role: "user", content: "x" }], stop: ["x".repeat(4096), "y".repeat(4096), "z".repeat(4096), "w".repeat(4097)] }),
  /AI request exceeds maxStopSequenceTotalCharacters/,
);

console.log("core request parameter-bound tests passed");
