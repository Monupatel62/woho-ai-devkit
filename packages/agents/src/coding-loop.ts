import type { AIClient } from "@woho/core";
import type { AgentTool, AgentRunResult, AgentRunOptions } from "./index.js";

export interface CodingLoopPolicy {
  readonly maxAttempts?: number;
}

export interface CodingLoopTask {
  readonly goal: string;
  readonly verify?: string;
}

export interface CodingLoopResult {
  readonly attempts: number;
  readonly results: readonly AgentRunResult[];
  readonly final: AgentRunResult;
}

export type CodingLoopRunner = (input: string, options?: AgentRunOptions) => Promise<AgentRunResult>;

export async function runCodingLoop(
  ai: AIClient,
  runner: CodingLoopRunner,
  task: CodingLoopTask,
  policy: CodingLoopPolicy = {},
  options: AgentRunOptions = {},
): Promise<CodingLoopResult> {
  if (!task.goal.trim()) throw new Error("Coding goal is required");
  const maxAttempts = policy.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
  const results: AgentRunResult[] = [];
  let instruction = task.goal.trim();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runner(instruction, options);
    results.push(result);
    if (!task.verify?.trim()) return { attempts: attempt, results, final: result };
    const verification = await ai.chat({
      messages: [
        { role: "system", content: "You are a strict software verification agent. Return ONLY PASS or FAIL followed by a concise reason. Do not invent test execution." },
        { role: "user", content: `Goal:\n${task.goal}\nVerification requirement:\n${task.verify}\nAgent result:\n${result.text}` },
      ],
      signal: options.signal,
    });
    if (/^PASS\b/i.test(verification.text.trim())) {
      return { attempts: attempt, results, final: result };
    }
    if (attempt < maxAttempts) {
      instruction = `${task.goal}\n\nPrevious attempt did not verify successfully. Diagnose and fix the failure before finishing.\nVerification feedback:\n${verification.text.slice(0, 12_000)}`;
    }
  }
  throw new Error("Coding loop exhausted without verified completion");
}

export function createCodingLoopTool(
  ai: AIClient,
  runner: CodingLoopRunner,
  policy: CodingLoopPolicy = {},
): AgentTool {
  return {
    name: "coding_loop",
    description: "Run an authorized coding task with bounded execute, observe, verify, and fix retries.",
    capability: "coding",
    action: "execute",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string" },
        verify: { type: "string" }
      },
      required: ["goal"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const value = input as Record<string, unknown>;
      if (typeof value.goal !== "string" || !value.goal.trim()) throw new Error("goal is required");
      if (value.verify !== undefined && typeof value.verify !== "string") throw new Error("verify must be a string");
      return runCodingLoop(ai, runner, { goal: value.goal, verify: value.verify as string | undefined }, policy, {
        runId: context?.runId,
        signal: context?.signal,
      });
    },
  };
}
