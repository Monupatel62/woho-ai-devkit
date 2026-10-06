import assert from "node:assert/strict";
import { createAI, createMockProvider, AIError } from "@woho/core";
import { createInMemoryStore } from "@woho/memory";
import { createAgent, AgentRegistry, AgentRuntime, InMemoryExecutionStore, runAgentPlan } from "./index.js";
import { createSpecializedAgent } from "./specialized.js";

const run = async () => {
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "", maxSteps: 1 }), /Agent name is required/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxSteps: 0 }), /maxSteps must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxContextMessages: 0 }), /maxContextMessages must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxContextChars: 0 }), /maxContextChars must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxToolResultChars: 0 }), /maxToolResultChars must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxToolCallsPerStep: 0 }), /maxToolCallsPerStep must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", maxToolArgumentBytes: 0 }), /maxToolArgumentBytes must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", toolTimeoutMs: 0 }), /toolTimeoutMs must be a positive integer/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", tools: [{ name: "dup", description: "a", execute: async () => 1 }, { name: "dup", description: "b", execute: async () => 2 }] }), /Duplicate tool name/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", tools: [{ name: "x", description: "", execute: async () => 1 }] }), /Tool description is required/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", tools: [{ name: " echo ", description: "Echo", execute: async () => 1 }] }), /surrounding whitespace/);
  assert.throws(() => createAgent(createAI({ provider: createMockProvider() }), { name: "x", tools: [{ name: "same", description: "a", execute: async () => 1 }, { name: "same", description: "b", execute: async () => 2 }] }), /Duplicate tool name/);

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

  const malformed = createAgent(createAI({
    provider: {
      name: "malformed",
      async chat() { return { id: "bad", text: "", model: "malformed", finishReason: "tool_call", toolCalls: [{ id: "bad-1", name: "echo", arguments: "{" }] }; },
    },
  }), { name: "malformed-agent", maxSteps: 1, tools: [{ name: "echo", description: "Echo", execute: async () => "ok" }] });
  await assert.rejects(malformed.run("bad args"), (error) => error instanceof AIError && error.code === "AGENT_MAX_STEPS");

  const fanout = createAgent(createAI({
    provider: {
      name: "fanout",
      async chat() {
        return { id: "fanout", text: "", model: "fanout", finishReason: "tool_call", toolCalls: [
          { id: "one", name: "echo", arguments: "{}" },
          { id: "two", name: "echo", arguments: "{}" },
          { id: "three", name: "echo", arguments: "{}" },
        ] };
      },
    },
  }), { name: "fanout-agent", maxToolCallsPerStep: 2, tools: [{ name: "echo", description: "Echo", execute: async () => "ok" }] });
  await assert.rejects(fanout.run("too many calls"), (error) => error instanceof AIError && error.code === "AGENT_TOOL_CALL_LIMIT");

  const largeArguments = createAgent(createAI({
    provider: {
      name: "large-arguments",
      async chat() {
        return { id: "large-arguments", text: "", model: "large-arguments", finishReason: "tool_call", toolCalls: [{ id: "large", name: "echo", arguments: "😀😀" }] };
      },
    },
  }), { name: "large-arguments-agent", maxToolArgumentBytes: 4, tools: [{ name: "echo", description: "Echo", execute: async () => "ok" }] });
  await assert.rejects(largeArguments.run("large arguments"), (error) => error instanceof AIError && error.code === "TOOL_ARGUMENTS_TOO_LARGE");

  const failing = createAgent(createAI({
    provider: {
      name: "tool-loop",
      async chat() {
        return { id: "loop", text: "", model: "tool-loop", finishReason: "tool_call", toolCalls: [{ id: "x", name: "missing", arguments: "{}" }] };
      },
    },
  }), { name: "loop", maxSteps: 1 });
  await assert.rejects(failing.run("loop"), (error) => error instanceof AIError && error.code === "AGENT_MAX_STEPS");

  const timeoutTool = createAgent(createAI({
    provider: {
      name: "timeout-tool",
      async chat(request) {
        if (request.messages.at(-1)?.role === "tool") return { id: "done", text: "done", model: "timeout-tool" };
        return { id: "call", text: "", model: "timeout-tool", finishReason: "tool_call", toolCalls: [{ id: "slow-1", name: "slow", arguments: "{}" }] };
      },
    },
  }), { name: "timeout-agent", maxToolResultChars: 100, toolTimeoutMs: 5, tools: [{ name: "slow", description: "Slow", execute: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return "late"; } }] });
  const timeoutResult = await timeoutTool.run("run");
  assert.equal(timeoutResult.text, "done");
  assert.equal((timeoutResult.toolResults["slow-1"] as { error?: unknown }).error, "TOOL_TIMEOUT");

  const limitedTool = createAgent(createAI({
    provider: {
      name: "large-result",
      async chat(request) {
        if (request.messages.at(-1)?.role === "tool") return { id: "done", text: "done", model: "large-result" };
        return { id: "call", text: "", model: "large-result", finishReason: "tool_call", toolCalls: [{ id: "large-1", name: "large", arguments: "{}" }] };
      },
    },
  }), { name: "large-result-agent", maxToolResultChars: 64, tools: [{ name: "large", description: "Large result", execute: async () => "abcdefghijklmnopqrstuvwxyz" }] });
  const largeResult = await limitedTool.run("run");
  assert.equal(largeResult.text, "done");
  assert.ok((largeResult.messages.at(-2)?.content ?? "").includes("[tool result truncated]"));

  const permissioned = createAgent(createAI({ provider: createMockProvider({ response: "permission-ok", toolCall: { name: "secure", arguments: "{}" } }) }), {
    name: "permissioned",
    permissions: { check: () => ({ allowed: false, reason: "needs approval", requiresApproval: true }) },
    tools: [{ name: "secure", description: "secure", capability: "computer", action: "execute", execute: async () => "secret" }],
    maxSteps: 2,
  });
  const denied = await permissioned.run("run secure");
  assert.equal((denied.toolResults["mock-call-1"] as { error?: unknown }).error, "APPROVAL_REQUIRED");
  const missingPolicy = createAgent(createAI({ provider: createMockProvider({ response: "policy-required", toolCall: { name: "unprotected", arguments: "{}" } }) }), {
    name: "missing-policy",
    tools: [{ name: "unprotected", description: "Unprotected", capability: "computer", action: "execute", execute: async () => "should-not-run" }],
    maxSteps: 2,
  });
  const missingPolicyResult = await missingPolicy.run("run unprotected");
  assert.equal((missingPolicyResult.toolResults["mock-call-1"] as { error?: unknown }).error, "PERMISSION_POLICY_REQUIRED");
  let toolAborted = false;
  const abortingTool = createAgent(createAI({
    provider: {
      name: "abort-tool",
      async chat(request) {
        if (request.messages.at(-1)?.role === "tool") return { id: "done", text: "done", model: "abort-tool" };
        return { id: "call", text: "", model: "abort-tool", finishReason: "tool_call", toolCalls: [{ id: "abort-1", name: "abortable", arguments: "{}" }] };
      },
    },
  }), {
    name: "abortable-agent",
    toolTimeoutMs: 5,
    tools: [{
      name: "abortable",
      description: "Abortable",
      execute: async (_input, context) => {
        await new Promise<void>((resolve) => {
          context?.signal?.addEventListener("abort", () => { toolAborted = true; resolve(); }, { once: true });
        });
        return "never";
      },
    }],
  });
  const abortingResult = await abortingTool.run("run");
  assert.equal(abortingResult.text, "done");
  assert.equal(toolAborted, true);
  const hugeToolResult = createAgent(createAI({
    provider: {
      name: "huge-result",
      async chat(request) {
        if (request.messages.at(-1)?.role === "tool") return { id: "done", text: "done", model: "huge-result" };
        return { id: "call", text: "", model: "huge-result", finishReason: "tool_call", toolCalls: [{ id: "huge-1", name: "huge", arguments: "{}" }] };
      },
    },
  }), {
    name: "huge-result-agent",
    maxToolResultChars: 128,
    tools: [{
      name: "huge",
      description: "Huge result",
      execute: async () => ({ values: Array.from({ length: 1_000_000 }, (_, index) => index) }),
    }],
  });
  const hugeResult = await hugeToolResult.run("bounded result");
  const hugeToolMessage = hugeResult.messages.find((message) => message.role === "tool");
  assert.ok((hugeToolMessage?.content.length ?? 0) <= 128);
  assert.match(hugeToolMessage?.content ?? "", /truncated/);

  const calling = createSpecializedAgent(createAI({ provider: createMockProvider({ response: "calling-role" }) }), "calling");
  assert.equal(calling.role, "calling");
  assert.ok(calling.capabilities.includes("calling"));
  const registry = new AgentRegistry();
  registry.register({ id: "general", name: "General", role: "general" }, ({ ai }) => createAgent(ai, { name: "General" }));
  assert.equal(registry.list()[0]?.role, "general");
  const runtimeEvents: string[] = [];
  const runtime = new AgentRuntime({ maxConcurrency: 2, onEvent: (event) => { runtimeEvents.push(event.type); } }, registry);
  const runtimeResult = await runtime.run(createAI({ provider: createMockProvider({ response: "runtime-ok" }) }), { agent: "general", input: "hello" });
  assert.equal(runtimeResult.text, "runtime-ok");
  assert.equal(runtimeEvents[0], "run.started");
  assert.equal(runtimeEvents.at(-1), "run.completed");
  class AtomicEventStore extends InMemoryExecutionStore {
    transitionCalls = 0;
    override async transition(runId: string, patch: Partial<import("./execution-store.js").ExecutionRecord>, event: import("@woho/core").ExecutionEvent, expectedUpdatedAt?: number): Promise<void> {
      this.transitionCalls += 1;
      return super.transition(runId, patch, event, expectedUpdatedAt);
    }
    override async appendEvent(): Promise<void> {
      throw new Error("recordAgentEvent must use transition when available");
    }
  }
  const atomicEventStore = new AtomicEventStore();
  const atomicEventRuntime = new AgentRuntime({ store: atomicEventStore }, registry);
  const atomicRun = await atomicEventRuntime.run(createAI({ provider: createMockProvider({ response: "atomic-ok" }) }), { agent: "general", input: "atomic" });
  const runtimeAtomicRecord = atomicEventStore.get(atomicRun.runId);
  assert.equal(runtimeAtomicRecord?.status, "succeeded");
  assert.ok(atomicEventStore.transitionCalls >= 1);
  const parallel = await runtime.runParallel(createAI({ provider: createMockProvider({ response: "parallel-ok" }) }), [
    { agent: "general", input: "one" }, { agent: "general", input: "two" },
  ]);
  assert.equal(parallel.length, 2);
  await assert.rejects(() => runtime.run(createAI({ provider: createMockProvider({ response: "x" }) }), { agent: "missing", input: "x" }), /Unknown agent/);
  const planResult = await runAgentPlan(runtime, createAI({ provider: createMockProvider({ response: "plan-ok" }) }), {
    steps: [
      { id: "research", agent: "general", input: "research" },
      { id: "draft", agent: "general", input: "draft", dependsOn: ["research"] },
      { id: "review-a", agent: "general", input: "review a", dependsOn: ["draft"] },
      { id: "review-b", agent: "general", input: "review b", dependsOn: ["draft"] },
    ],
  });
  assert.deepEqual(planResult.order, ["research", "draft", "review-a", "review-b"]);
  assert.equal(planResult.steps["review-b"]?.text, "plan-ok");
  await assert.rejects(() => runAgentPlan(runtime, createAI({ provider: createMockProvider({ response: "x" }) }), {
    steps: [
      { id: "a", agent: "general", input: "a", dependsOn: ["b"] },
      { id: "b", agent: "general", input: "b", dependsOn: ["a"] },
    ],
  }), /cycle or unknown dependency/);
  assert.throws(() => new AgentRuntime({ retry: { maxAttempts: 0 } }), /retry.maxAttempts/);
  assert.throws(() => new AgentRuntime({ heartbeatIntervalMs: 0 }), /heartbeatIntervalMs/);
  assert.throws(() => new AgentRuntime({ maxInputBytes: 0 }), /maxInputBytes/);

  const boundedInputStore = new InMemoryExecutionStore();
  const boundedInputRuntime = new AgentRuntime({ store: boundedInputStore, maxInputBytes: 8 }, registry);
  await assert.rejects(
    () => boundedInputRuntime.run(createAI({ provider: createMockProvider({ response: "ok" }) }), { agent: "general", input: "123456789" }),
    /Agent input exceeds maxInputBytes/,
  );

  const privateInputStore = new InMemoryExecutionStore();
  const privateInputRuntime = new AgentRuntime({ store: privateInputStore, persistInput: false }, registry);
  const privateRun = await privateInputRuntime.run(
    createAI({ provider: createMockProvider({ response: "private-ok" }) }),
    { agent: "general", input: "super-secret prompt" },
  );
  const privateRecord = privateInputStore.get(privateRun.runId);
  assert.equal(privateRecord?.input, undefined);
  assert.ok(!privateRecord?.events.some((event) => JSON.stringify(event).includes("super-secret prompt")));

  const utf8InputStore = new InMemoryExecutionStore();
  const utf8InputRuntime = new AgentRuntime({ store: utf8InputStore, maxInputBytes: 4 }, registry);
  await assert.rejects(
    () => utf8InputRuntime.run(createAI({ provider: createMockProvider({ response: "ok" }) }), { agent: "general", input: "😀😀" }),
    /Agent input exceeds maxInputBytes/,
  );
  let retryCount = 0;
  const retryRegistry = new AgentRegistry();
  retryRegistry.register({ id: "retry", name: "Retry", role: "general" }, ({ ai }) => createAgent(ai, { name: "Retry" }));
  const retryRuntime = new AgentRuntime({ maxConcurrency: 1, retry: { maxAttempts: 2, delayMs: 0 } }, retryRegistry);
  const retryAI = createAI({ provider: { name: "retry", async chat() { retryCount += 1; if (retryCount === 1) throw new Error("retry-me"); return { id: "ok", text: "recovered", model: "retry" }; } } });
  const retryResult = await retryRuntime.run(retryAI, { agent: "retry", input: "recover" });
  assert.equal(retryResult.text, "recovered");
  assert.equal(retryCount, 2);
  const executionStore = new InMemoryExecutionStore();
  const storedRuntime = new AgentRuntime({ store: executionStore }, registry);
  const stored = await storedRuntime.run(createAI({ provider: createMockProvider({ response: "stored" }) }), { agent: "general", input: "store me" });
  const record = executionStore.get(stored.runId);
  assert.equal(record?.status, "succeeded");
  assert.ok((record?.events.length ?? 0) >= 2);
  const atomicStore = new InMemoryExecutionStore();
  await atomicStore.create({
    runId: "atomic-transition",
    agent: "general",
    input: "atomic",
    metadata: {},
    status: "running",
    startedAt: 100,
    updatedAt: 100,
    attempts: 1,
    events: [],
  });
  const atomicEvent = {
    type: "run.completed" as const,
    runId: "atomic-transition",
    timestamp: 200,
    data: { agent: "general", steps: 1, attempts: 1, verified: false },
  };
  atomicStore.transition("atomic-transition", { status: "succeeded", completedAt: 200 }, atomicEvent);
  const atomicRecord = atomicStore.get("atomic-transition");
  assert.equal(atomicRecord?.status, "succeeded");
  assert.equal(atomicRecord?.updatedAt, 200);
  assert.equal(atomicRecord?.events.at(-1)?.type, "run.completed");
  assert.equal(atomicRecord?.events.at(-1)?.timestamp, 200);
  assert.throws(() => executionStore.update(stored.runId, { status: "running" }), /Invalid execution status transition: succeeded -> running/);
  assert.equal(executionStore.updateIf?.(stored.runId, record?.updatedAt ?? 0, { status: "running" }), false);

  const recoverStore = new InMemoryExecutionStore();
  await recoverStore.create({
    runId: "stale-runtime-run",
    agent: "general",
    metadata: {},
    status: "running",
    startedAt: 100,
    updatedAt: 100,
    attempts: 1,
    events: [],
  });
  const maintenanceRuntime = new AgentRuntime({ store: recoverStore }, registry);
  const recoveredRuns = await maintenanceRuntime.recoverStale({ staleAfterMs: 50, now: 200 });
  assert.equal(recoveredRuns.length, 1);
  assert.equal(recoveredRuns[0]?.status, "failed");
  const recoveredRecord = recoverStore.get("stale-runtime-run");
  assert.equal(recoveredRecord?.updatedAt, 200);
  assert.equal(recoveredRecord?.completedAt, 200);
  assert.equal(recoveredRecord?.events.length, 1);
  assert.equal(recoveredRecord?.events[0]?.type, "run.failed");
  assert.equal(recoveredRecord?.events[0]?.timestamp, 200);
  const casRecoveryStore = new InMemoryExecutionStore();
  await casRecoveryStore.create({
    runId: "cas-recovery",
    agent: "general",
    metadata: {},
    status: "running",
    startedAt: 100,
    updatedAt: 100,
    attempts: 1,
    events: [],
  });
  casRecoveryStore.update("cas-recovery", { updatedAt: 150 });
  const staleEvent = {
    type: "run.failed" as const,
    runId: "cas-recovery",
    timestamp: 200,
    data: { reason: "stale", staleAfterMs: 50 },
  };
  assert.throws(
    () => casRecoveryStore.transition("cas-recovery", { status: "failed" }, staleEvent, 100),
    /Execution changed before transition/,
  );
  assert.equal(casRecoveryStore.get("cas-recovery")?.status, "running");
  const resumableStore = new InMemoryExecutionStore();
  await resumableStore.create({
    runId: "failed-resumable",
    agent: "general",
    input: "resume this task",
    metadata: { source: "resume-test" },
    status: "failed",
    startedAt: 100,
    updatedAt: 200,
    completedAt: 200,
    attempts: 1,
    events: [],
  });
  const resumableRuntime = new AgentRuntime({ store: resumableStore }, registry);
  const resumed = await resumableRuntime.resume(createAI({ provider: createMockProvider({ response: "resumed-ok" }) }), "failed-resumable");
  assert.equal(resumed.text, "resumed-ok");
  assert.notEqual(resumed.runId, "failed-resumable");
  assert.equal(resumableStore.get(resumed.runId)?.parentRunId, "failed-resumable");
  assert.equal(resumableStore.get(resumed.runId)?.input, "resume this task");
  await resumableStore.create({
    runId: "legacy-failed",
    agent: "general",
    metadata: {},
    status: "failed",
    startedAt: 100,
    updatedAt: 200,
    attempts: 1,
    events: [],
  });
  await assert.rejects(() => resumableRuntime.resume(createAI({ provider: createMockProvider({ response: "x" }) }), "legacy-failed"), /does not contain input/);
  const concurrentResumeStore = new InMemoryExecutionStore();
  await concurrentResumeStore.create({
    runId: "concurrent-resume",
    agent: "general",
    input: "resume once",
    metadata: {},
    status: "failed",
    startedAt: 100,
    updatedAt: 200,
    completedAt: 200,
    attempts: 1,
    events: [],
  });
  const concurrentResumeRuntime = new AgentRuntime({ store: concurrentResumeStore }, registry);
  const concurrentResults = await Promise.allSettled([
    concurrentResumeRuntime.resume(createAI({ provider: createMockProvider({ response: "resume-ok" }) }), "concurrent-resume"),
    concurrentResumeRuntime.resume(createAI({ provider: createMockProvider({ response: "resume-ok" }) }), "concurrent-resume"),
  ]);
  assert.equal(concurrentResults.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrentResults.filter((result) => result.status === "rejected").length, 1);
  assert.ok(concurrentResumeStore.get("concurrent-resume")?.resumeRunId);
  assert.equal(concurrentResumeStore.list().filter((record) => record.parentRunId === "concurrent-resume").length, 1);
  const prunedRuns = await maintenanceRuntime.pruneHistory({ maxRecords: 0, status: "failed" });
  assert.equal(prunedRuns.length, 1);
  assert.equal(recoverStore.get("stale-runtime-run"), undefined);
  await assert.rejects(() => new AgentRuntime().recoverStale({ staleAfterMs: 50 }), /Execution store is required/);
  await assert.rejects(() => new AgentRuntime().pruneHistory({ maxRecords: 0 }), /Execution store is required/);
  const contextualPlan = await runAgentPlan(runtime, createAI({ provider: createMockProvider({ response: "context-ok" }) }), { steps: [
    { id: "first", agent: "general", input: "first" },
    { id: "second", agent: "general", input: ({ completed }) => "second after " + completed.first?.text, dependsOn: ["first"] },
  ] });
  assert.equal(contextualPlan.steps.second?.text, "context-ok");
  let approved = false;
  const approvalEvents: string[] = [];
  const approvalAgent = createAgent(createAI({ provider: createMockProvider({ response: "approved", toolCall: { name: "protected", arguments: "{}" } }) }), {
    name: "approval",
    permissions: { check: () => ({ allowed: false, reason: "manual approval", requiresApproval: true }) },
    tools: [{ name: "protected", description: "Protected", capability: "computer", action: "execute", execute: async () => "allowed" }],
  });
  const approvalResult = await approvalAgent.run("run", { runId: "approval-run", onEvent: (event) => { approvalEvents.push(event.type); }, approval: async () => { approved = true; return true; } });
  assert.equal(approved, true);
  assert.ok(approvalEvents.includes("run.waiting"));
  assert.equal(approvalResult.toolResults["mock-call-1"], "allowed");
  let runtimeApproved = false;
  const approvalRuntime = new AgentRuntime({
    approval: async () => { runtimeApproved = true; return true; },
  }, registry);
  const approvalRuntimeAgent = createAgent(
    createAI({ provider: createMockProvider({ response: "runtime-approved", toolCall: { name: "protected-runtime", arguments: "{}" } }) }),
    {
      name: "runtime-approval",
      permissions: { check: () => ({ allowed: false, reason: "runtime approval", requiresApproval: true }) },
      tools: [{ name: "protected-runtime", description: "Protected", capability: "computer", action: "execute", execute: async () => "approved-by-runtime" }],
    },
  );
  const approvalRuntimeRegistry = new AgentRegistry();
  approvalRuntimeRegistry.register({ id: "runtime-approval", name: "Runtime Approval", role: "general" }, () => approvalRuntimeAgent);
  const approvalRuntimeRunner = new AgentRuntime({
    approval: async () => { runtimeApproved = true; return true; },
  }, approvalRuntimeRegistry);
  const runtimeApprovalResult = await approvalRuntimeRunner.run(createAI({ provider: createMockProvider({ response: "runtime-approved", toolCall: { name: "protected-runtime", arguments: "{}" } }) }), { agent: "runtime-approval", input: "approve" });
  assert.equal(runtimeApproved, true);
  assert.equal(runtimeApprovalResult.toolResults["mock-call-1"], "approved-by-runtime");
  const toolErrorEvents: import("@woho/core").ExecutionEvent[] = [];
  const secretErrorAgent = createAgent(
    createAI({ provider: createMockProvider({ response: "tool-failed", toolCall: { name: "secret-tool", arguments: "{}" } }) }),
    {
      name: "secret-error",
      tools: [{ name: "secret-tool", description: "Secret tool", execute: async () => { throw new Error("super-secret-provider-token"); } }],
    },
  );
  const secretErrorResult = await secretErrorAgent.run("test", { runId: "secret-error-run", onEvent: (event) => { toolErrorEvents.push(event); } });
  const failedToolEvent = toolErrorEvents.find((event) => event.type === "tool.completed" && event.data?.success === false);
  assert.equal(failedToolEvent?.data?.errorCode, "TOOL_EXECUTION_ERROR");
  assert.ok(!JSON.stringify(failedToolEvent).includes("super-secret-provider-token"));
  assert.equal((secretErrorResult.toolResults["mock-call-1"] as { error?: unknown })?.error, "TOOL_EXECUTION_ERROR");
  assert.ok(!JSON.stringify(secretErrorResult.toolResults).includes("super-secret-provider-token"));
  assert.ok(!JSON.stringify(secretErrorResult.messages).includes("super-secret-provider-token"));


  let verificationAttempts = 0;
  const verificationRuntime = new AgentRuntime({
    retry: { maxAttempts: 2, delayMs: 0 },
    verify: (result) => {
      verificationAttempts += 1;
      return result.text === "verified" && verificationAttempts === 2;
    },
  }, registry);
  const verificationResult = await verificationRuntime.run(
    createAI({ provider: createMockProvider({ response: "verified" }) }),
    { agent: "general", input: "verify" },
  );
  assert.equal(verificationResult.text, "verified");
  assert.equal(verificationAttempts, 2);
  const planVerification = await runAgentPlan(
    verificationRuntime,
    createAI({ provider: createMockProvider({ response: "plan-verified" }) }),
    { steps: [{ id: "verified-step", agent: "general", input: "verify", verify: (result) => result.text === "plan-verified" }] },
  );
  assert.equal(planVerification.steps["verified-step"]?.text, "plan-verified");
  class CountingExecutionStore extends InMemoryExecutionStore {
    updateCalls = 0;
    override update(runId: string, patch: Parameters<InMemoryExecutionStore["update"]>[1]): void {
      this.updateCalls += 1;
      super.update(runId, patch);
    }
  }
  const heartbeatStore = new CountingExecutionStore();
  const heartbeatRegistry = new AgentRegistry();
  heartbeatRegistry.register({ id: "heartbeat", name: "Heartbeat", role: "general" }, ({ ai }) => createAgent(ai, { name: "Heartbeat" }));
  const heartbeatRuntime = new AgentRuntime({ store: heartbeatStore, heartbeatIntervalMs: 5 }, heartbeatRegistry);
  const heartbeatAI = createAI({ provider: { name: "heartbeat", async chat() {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { id: "heartbeat", text: "heartbeat-ok", model: "heartbeat" };
  } } });
  const heartbeatResult = await heartbeatRuntime.run(heartbeatAI, { agent: "heartbeat", input: "wait" });
  assert.equal(heartbeatResult.text, "heartbeat-ok");
  assert.ok(heartbeatStore.updateCalls >= 4, "active execution should receive persisted heartbeat updates");

  const usageAI = createAI({
    provider: {
      name: "usage-test",
      async chat() {
        return {
          id: "usage",
          text: "usage-ok",
          model: "usage-test",
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: { currency: "USD", amount: 0.002 } },
        };
      },
    },
  });
  const usageAgent = createAgent(usageAI, { name: "usage-agent" });
  const usageResult = await usageAgent.run("usage");
  assert.deepEqual(usageResult.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: { currency: "USD", amount: 0.002 } });
  const usageStore = new InMemoryExecutionStore();
  const usageRuntime = new AgentRuntime({ store: usageStore }, registry);
  const usageRuntimeResult = await usageRuntime.run(usageAI, { agent: "general", input: "usage" });
  assert.deepEqual(usageStore.get(usageRuntimeResult.runId)?.usage, usageRuntimeResult.usage);
  console.log("agent runtime tests passed");
};
run().catch((error) => { console.error(error); process.exitCode = 1; });
