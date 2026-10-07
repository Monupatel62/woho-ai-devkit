import type { AIClient } from "@woho/core";
import type { AgentRunResult } from "./index.js";
import type { AgentRuntime, AgentTask, AgentVerifier } from "./runtime.js";
import type { WohoProjectContext } from "./project-context.js";
import { mergeWohoProjectMetadata } from "./project-context.js";

export interface AgentPlanContext {
  readonly completed: Readonly<Record<string, AgentRunResult & { runId: string }>>;
}

export interface AgentPlanStep {
  readonly id: string;
  readonly agent: string;
  readonly input: string | ((context: AgentPlanContext) => string);
  readonly dependsOn?: readonly string[];
  readonly sessionId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly verify?: AgentVerifier;
}

export interface AgentPlan {
  readonly steps: readonly AgentPlanStep[];
}

export interface AgentPlanResult {
  readonly steps: Record<string, AgentRunResult & { runId: string }>;
  readonly order: readonly string[];
}

export async function runAgentPlan(
  runtime: AgentRuntime,
  ai: AIClient,
  plan: AgentPlan,
  options: { readonly signal?: AbortSignal; readonly projectContext?: WohoProjectContext } = {},
): Promise<AgentPlanResult> {
  const steps = new Map<string, AgentPlanStep>();
  for (const step of plan.steps) {
    if (!step.id.trim()) throw new Error("Plan step id is required");
    if (steps.has(step.id)) throw new Error("Duplicate plan step id: " + step.id);
    steps.set(step.id, step);
  }

  const remaining = new Set(steps.keys());
  const completed = new Set<string>();
  const results: Record<string, AgentRunResult & { runId: string }> = {};
  const order: string[] = [];

  while (remaining.size) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Plan aborted");

    const ready = [...remaining].filter((id) => {
      const dependencies = steps.get(id)?.dependsOn ?? [];
      return dependencies.every((dependency) => completed.has(dependency));
    });

    if (!ready.length) {
      const unresolved = [...remaining].map((id) => ({
        id,
        dependsOn: steps.get(id)?.dependsOn ?? [],
      }));
      throw new Error("Agent plan contains a cycle or unknown dependency: " + JSON.stringify(unresolved));
    }

    const batch = await Promise.all(
      ready.map(async (id) => {
        const step = steps.get(id)!;
        const task: AgentTask = {
          agent: step.agent,
          input: typeof step.input === "function" ? step.input({ completed: results }) : step.input,
          projectId: options.projectContext?.projectId,
          sessionId: step.sessionId ?? options.projectContext?.sessionId,
          metadata: options.projectContext ? mergeWohoProjectMetadata(options.projectContext, step.metadata) : step.metadata,
          parentRunId: undefined,
          signal: options.signal,
          verify: step.verify,
        };
        return [id, await runtime.run(ai, task)] as const;
      }),
    );

    for (const [id, result] of batch) {
      results[id] = result;
      remaining.delete(id);
      completed.add(id);
      order.push(id);
    }
  }

  return { steps: results, order };
}
