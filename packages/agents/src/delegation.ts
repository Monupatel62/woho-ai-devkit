import type { AIClient } from "@woho/core";
import type { AgentTool } from "./index.js";
import type { AgentRegistry } from "./definition.js";
import type { AgentRuntime } from "./runtime.js";

export interface AgentDelegationPolicy {
  readonly allowedAgents?: readonly string[];
  readonly maxDepth?: number;
  readonly maxResultChars?: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(name + " must be a positive integer");
}

function serializeResult(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n[delegated result truncated]";
  const limit = Math.max(0, maxChars - suffix.length);
  return text.slice(0, limit) + suffix.slice(0, maxChars - limit);
}

export function createAgentDelegationTool(
  runtime: AgentRuntime,
  ai: AIClient,
  registry: AgentRegistry,
  policy: AgentDelegationPolicy = {},
): AgentTool {
  const allowedAgents = policy.allowedAgents ? new Set(policy.allowedAgents) : undefined;
  const maxDepth = policy.maxDepth ?? 2;
  const maxResultChars = policy.maxResultChars ?? 30_000;
  positiveInteger(maxDepth, "maxDepth");
  positiveInteger(maxResultChars, "maxResultChars");

  return {
    name: "delegate_agent",
    description: "Delegate a bounded subtask to one registered specialist agent and return its verified result.",
    capability: "agent:delegate",
    action: "execute",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string" },
        task: { type: "string" },
        depth: { type: "integer" },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const value = input as Record<string, unknown>;
      const agent = value.agent;
      const task = value.task;
      const depth = value.depth === undefined ? 0 : value.depth;
      if (typeof agent !== "string" || !agent.trim()) throw new Error("agent is required");
      if (typeof task !== "string" || !task.trim()) throw new Error("task is required");
      if (!Number.isInteger(depth) || depth < 0) throw new Error("depth must be a non-negative integer");
      if (depth >= maxDepth) throw new Error("Delegation depth limit exceeded");
      if (allowedAgents && !allowedAgents.has(agent)) throw new Error("Agent is not allowed by delegation policy");
      if (!registry.get(agent)) throw new Error("Unknown agent: " + agent);

      const result = await runtime.run(ai, {
        agent,
        input: task,
        parentRunId: context?.runId,
        metadata: { delegated: true, depth: depth + 1, delegatedBy: context?.runId },
        runId: undefined,
      });
      return {
        agent,
        runId: result.runId,
        steps: result.steps,
        text: serializeResult(result.text, maxResultChars),
      };
    },
  };
}
