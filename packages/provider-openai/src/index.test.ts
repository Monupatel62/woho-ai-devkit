import assert from "node:assert/strict";
import { AuthenticationError, ModelNotFoundError, RateLimitError } from "@woho/core";
import { createOpenAIProvider } from "./index.js";

const originalFetch = globalThis.fetch;
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const run = async () => {
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return jsonResponse({
      id: "chat-1",
      model: "test-model",
      choices: [{ message: { content: "hello", tool_calls: [{ id: "call-1", function: { name: "calculator", arguments: "{\"a\":2}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
  };

  const provider = createOpenAIProvider({ apiKey: "secret", baseUrl: "https://example.test/v1", defaultModel: "test-model" });
  const result = await provider.chat({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "calculator", description: "Calculate", parameters: { type: "object" } }],
  });
  assert.equal(result.text, "hello");
  assert.equal(result.toolCalls?.[0].name, "calculator");
  assert.equal(result.usage?.totalTokens, 5);
  assert.equal((captured?.headers as Headers).get("authorization"), "Bearer secret");
  assert.match(String(captured?.body), /calculator/);

  globalThis.fetch = async () => jsonResponse({}, 401);
  await assert.rejects(provider.chat({ messages: [{ role: "user", content: "x" }] }), (e) => e instanceof AuthenticationError);

  globalThis.fetch = async () => jsonResponse({}, 404);
  await assert.rejects(provider.chat({ messages: [{ role: "user", content: "x" }] }), (e) => e instanceof ModelNotFoundError);

  globalThis.fetch = async () => jsonResponse({}, 429);
  await assert.rejects(provider.chat({ messages: [{ role: "user", content: "x" }] }), (e) => e instanceof RateLimitError);

  globalThis.fetch = async () => new Response(
    'data: {"id":"s1","model":"test","choices":[{"delta":{"content":"hel"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const chunks: string[] = [];
  for await (const chunk of provider.stream!({ messages: [{ role: "user", content: "stream" }] })) chunks.push(chunk.text);
  assert.deepEqual(chunks, ["hel", "lo"]);

  globalThis.fetch = originalFetch;
  console.log("openai provider runtime tests passed");
};

run().catch((error) => {
  globalThis.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
