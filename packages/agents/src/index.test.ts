import assert from "node:assert/strict";
import { createAI, createMockProvider, AIError } from "@woho/core";
import { createInMemoryStore } from "@woho/memory";
import { createAgent } from "./index.js";

const run = async () => {
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "", maxSteps: 1 }), /Agent name is required/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxSteps: 0 }), /maxSteps must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxContextMessages: 0 }), /maxContextMessages must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxContextChars: 0 }), /maxContextChars must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxToolResultChars: 0 }), /maxToolResultChars must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", tools: [{ name: "dup", description: "a", execute: async () => 1 }, { name: "dup", description: "b", execute: async () => 2 }] }), /Duplicate tool name/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", tools: [{ name: "x", description: "", execute: async () => 1 }] }), /Tool description is required/);

  const store = createInMemoryStore();
  const ai = createAI({
    provider: createMockProvider({
      response: "calculated",
      toolCall: { name: "calculator", arguments: JSON.stringify({ a: 2, b: 3 }) },
    }),
  });
  const agent = createAgent(ai, {
    name: "calculator-agent",
    tools: [{
      name: "calculator",
      description: "Add two numbers",
      parameters: { type: "object" },
      async execute(input) {
        const value = input as { a: number; b: number };
        return value.a + value.b;
      },
    }],
    memory: store,
    sessionId: "session-a",
    maxSteps: 3,
  });
  const result = await agent.run("add 2 and 3");
  assert.equal(result.text, "calculated");
  assert.equal(result.steps, 2);
  assert.equal(result.toolResults["mock-call-1"], 5);
  assert.ok((await store.list({ sessionId: "session-a" })).length >= 3);

  const limited = createAgent(createAI({ provider: createMockProvider({ response: "ok" }) }), {
    name: "limited",
    maxContextMessages: 1,
    maxContextChars: 10,
  });
  assert.equal((await limited.run("hello")).text, "ok");

  const failing = createAgent(createAI({
    provider: {
      name: "tool-loop",
      async chat() {
        return { id: "loop", text: "", model: "tool-loop", finishReason: "tool_call", toolCalls: [{ id: "x", name: "missing", arguments: "{}" }] };
      },
    },
  }), { name: "loop", maxSteps: 1 });
  await assert.rejects(failing.run("loop"), (error) => error instanceof AIError && error.code === "AGENT_MAX_STEPS");

  const limitedTool = createAgent(createAI({
    provider: {
      name: "large-result",
      async chat(request) {
        if (request.messages.at(-1)?.role === "tool") return { id: "done", text: "done", model: "large-result" };
        return { id: "call", text: "", model: "large-result", finishReason: "tool_call", toolCalls: [{ id: "large-1", name: "large", arguments: "{}" }] };
      },
    },
  }), { name: "large-result-agent", maxToolResultChars: 20, tools: [{ name: "large", description: "Large result", execute: async () => "abcdefghijklmnopqrstuvwxyz" }] });
  const largeResult = await limitedTool.run("run");
  assert.equal(largeResult.text, "done");
  assert.ok((largeResult.messages.at(-2)?.content ?? "").includes("[tool result truncated]"));

  console.log("agent runtime tests passed");
};
run().catch((error) => { console.error(error); process.exitCode = 1; });
