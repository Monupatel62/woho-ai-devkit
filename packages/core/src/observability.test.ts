import assert from "node:assert/strict";
import { createAI, createMockProvider } from "./index.js";

const events: string[] = [];
const ai = createAI({
  provider: createMockProvider({ response: "ok" }),
  observability: { onEvent: async (event) => { events.push(event.type); } },
});
const result = await ai.chat({ messages: [{ role: "user", content: "hello" }] });
assert.equal(result.text, "ok");
assert.deepEqual(events, ["request.start", "request.success"]);

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

console.log("core observability tests passed");
