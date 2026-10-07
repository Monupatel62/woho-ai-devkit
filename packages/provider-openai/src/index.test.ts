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

  assert.throws(() => createOpenAIProvider({ apiKey: " ", baseUrl: "https://example.test/v1" }), /API key is required/);
  assert.throws(() => createOpenAIProvider({ apiKey: "secret", baseUrl: "http://example.test/v1" }), /HTTPS/);
  assert.throws(() => createOpenAIProvider({ apiKey: "secret", maxResponseBytes: 0 }), /maxResponseBytes/);
  assert.throws(() => createOpenAIProvider({ apiKey: "secret", maxRequestBytes: 0 }), /maxRequestBytes/);
  const provider = createOpenAIProvider({ apiKey: "secret", baseUrl: "https://example.test/v1", defaultModel: "test-model" });
  const result = await provider.chat({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "calculator", description: "Calculate", parameters: { type: "object" } }],
  });
  assert.equal(result.text, "hello");
  assert.equal(result.toolCalls?.[0].name, "calculator");
  assert.equal(result.usage?.totalTokens, 5);
  assert.equal((captured?.headers as Record<string, string>).authorization, "Bearer secret");
  assert.match(String(captured?.body), /calculator/);

  globalThis.fetch = async () => new Response("{bad-json}", { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(provider.chat({ messages: [{ role: "user", content: "malformed" }] }), /Malformed provider JSON response/);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(
    provider.chat({ messages: [{ role: "user", content: "secret-request" }], tools: [{ name: "circular", description: "secret", parameters: circular }] }),
    (e) => e instanceof Error && e.message === "Provider request is not serializable" && !e.message.includes("secret"),
  );

  const bounded = createOpenAIProvider({ apiKey: "secret", baseUrl: "https://example.test/v1", maxRequestBytes: 20 });
  await assert.rejects(
    bounded.chat({ messages: [{ role: "user", content: "this request is too large" }] }),
    /maxRequestBytes/,
  );

  const hugeBounded = createOpenAIProvider({ apiKey: "secret", baseUrl: "https://example.test/v1", maxRequestBytes: 128 });
  await assert.rejects(
    hugeBounded.chat({ messages: [{ role: "user", content: "x" }], tools: [{ name: "huge", description: "huge", parameters: { values: Array.from({ length: 1_000_000 }, (_, index) => index) } }] }),
    /maxRequestBytes/,
  );

  globalThis.fetch = async () => jsonResponse({}, 401);
  await assert.rejects(provider.chat({ messages: [{ role: "user", content: "x" }] }), (e) => e instanceof AuthenticationError);

  globalThis.fetch = async () => jsonResponse({ error: "secret-provider-detail" }, 400);
  await assert.rejects(
    provider.chat({ messages: [{ role: "user", content: "x" }] }),
    (e) => e instanceof Error && e.message === "Provider rejected the request" && !e.message.includes("secret-provider-detail"),
  );

  globalThis.fetch = async () => jsonResponse({}, 404);
  await assert.rejects(provider.chat({ messages: [{ role: "user", content: "x" }] }), (e) => e instanceof ModelNotFoundError);

  globalThis.fetch = async () => jsonResponse({ ok: true }, 200);
  const oversizedChat = createOpenAIProvider({ apiKey: "secret", baseUrl: "https://example.test/v1", maxResponseBytes: 10 });
  await assert.rejects(oversizedChat.chat({ messages: [{ role: "user", content: "x" }] }), /maxResponseBytes/);

  globalThis.fetch = async () => new Response("internal-secret-provider-detail", { status: 500, headers: { "content-type": "text/plain" } });
  await assert.rejects(
    oversizedChat.chat({ messages: [{ role: "user", content: "oversized-error" }] }),
    (e) => e instanceof Error && !e.message.includes("internal-secret-provider-detail"),
  );

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

  const malformedUtf8Stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\n"));
      controller.enqueue(new Uint8Array([0xE2]));
      controller.close();
    },
  });
  globalThis.fetch = async () => new Response(malformedUtf8Stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  const malformedUtf8 = provider.stream!({ messages: [{ role: "user", content: "malformed utf8" }] });
  await assert.rejects(async () => { for await (const _ of malformedUtf8) { /* expected failure */ } }, /Malformed provider SSE frame/);

  globalThis.fetch = async () => new Response('data: {bad-json}\\n\\n', { status: 200, headers: { "content-type": "text/event-stream" } });
  const malformed = provider.stream!({ messages: [{ role: "user", content: "bad" }] });
  await assert.rejects(async () => { for await (const _ of malformed) { /* expected failure */ } }, /Malformed provider SSE frame/);

  globalThis.fetch = async () => new Response("data: " + JSON.stringify({ choices: [{ delta: { content: "123456789" } }] }) + "\\n\\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  const oversizedStream = createOpenAIProvider({ apiKey: "secret", baseUrl: "https://example.test/v1", maxResponseBytes: 10 });
  await assert.rejects(async () => { for await (const _ of oversizedStream.stream!({ messages: [{ role: "user", content: "x" }] })) { /* expected */ } }, /maxResponseBytes/);

  globalThis.fetch = originalFetch;
  console.log("openai provider runtime tests passed");
};

run().catch((error) => {
  globalThis.fetch = originalFetch;
  console.error(error);
  process.exitCode = 1;
});
