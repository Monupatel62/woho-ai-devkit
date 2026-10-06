import type { AIClient } from "@woho/core";
import { Agent, type AgentTool, type AgentRunResult } from "./index.js";
import { AgentRuntime, type AgentRuntimeOptions, type AgentTask } from "./runtime.js";
import { AgentRegistry, type AgentDefinition, type AgentRole } from "./definition.js";
import { createAgentDelegationTool, type AgentDelegationPolicy } from "./delegation.js";
import { runAgentPlan, type AgentPlan, type AgentPlanResult } from "./plan.js";

export interface WohoAgentPlatformOptions {
  readonly runtime?: AgentRuntimeOptions;
  readonly registry?: AgentRegistry;
  readonly commonTools?: readonly AgentTool[];
  readonly toolsByRole?: Partial<Record<AgentRole, readonly AgentTool[]>>;
  readonly permissionsByRole?: Partial<Record<AgentRole, AgentDefinition["permissions"]>>;
  readonly maxPlanSteps?: number;
  readonly maxPlanGoalBytes?: number;
  readonly delegation?: AgentDelegationPolicy;
}

export interface WohoAgentPlatform {
  readonly registry: AgentRegistry;
  readonly runtime: AgentRuntime;
  readonly plan: (ai: AIClient, goal: string, options?: { signal?: AbortSignal }) => Promise<AgentPlan>;
  readonly runPlan: (ai: AIClient, plan: AgentPlan, options?: { signal?: AbortSignal }) => Promise<AgentPlanResult>;
  readonly run: (ai: AIClient, goal: string, options?: { signal?: AbortSignal; agent?: string }) => Promise<AgentPlanResult>;
  readonly runAgent: (ai: AIClient, task: AgentTask) => Promise<AgentRunResult & { runId: string }>;
}

const ROLES: readonly AgentRole[] = [
  "orchestrator", "planner", "calling", "communication", "computer", "browser",
  "file", "coding", "research", "testing", "security", "git", "documentation", "data", "general",
];

const ROLE_INSTRUCTIONS: Record<AgentRole, string> = {
  orchestrator: "Coordinate specialist agents. Delegate only bounded, authorized work and require verification before completion.",
  planner: "Decompose goals into small, independently verifiable tasks with explicit dependencies. Never invent unavailable capabilities.",
  calling: "Handle authorized calling workflows. Never initiate or control a call without the calling capability and required approval.",
  communication: "Handle authorized communication workflows. Treat sending external messages as consequential and require approval when policy demands it.",
  computer: "Operate an authorized computer environment. Observe before consequential actions and verify outcomes.",
  browser: "Operate an authorized browser. Respect network/domain/action policy and verify consequential navigation or submissions.",
  file: "Inspect and modify authorized files using minimal, scoped changes and verify the result.",
  coding: "Develop software changes: inspect first, edit minimally, run focused tests, diagnose failures, and verify the final state.",
  research: "Research authorized sources, distinguish evidence from inference, and return concise traceable findings.",
  testing: "Design and execute focused tests, diagnose failures, and report reproducible evidence.",
  security: "Audit code, tools, permissions, secrets, resource limits, and trust boundaries. Fail closed on unsafe designs.",
  git: "Inspect repository state and perform only authorized Git operations with explicit change boundaries.",
  documentation: "Produce accurate documentation based on verified implementation behavior.",
  data: "Transform and analyze authorized data with bounded resources and preserved correctness.",
  general: "Complete the assigned task with available authorized tools, memory, and verification.",
};

function agentId(role: AgentRole): string { return `woho-${role}`; }

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  try { return JSON.parse(candidate) as unknown; }
  catch { throw new Error("Planner returned invalid JSON"); }
}

function validatePlan(value: unknown, allowedAgents: ReadonlySet<string>, maxSteps: number): AgentPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Planner output must be an object");
  const steps = (value as Record<string, unknown>).steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > maxSteps) throw new Error("Planner returned an invalid step count");
  const ids = new Set<string>();
  const result: AgentPlan["steps"] = [];
  for (const raw of steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Planner returned an invalid step");
    const item = raw as Record<string, unknown>;
    const id = item.id;
    const agent = item.agent;
    const input = item.input;
    const dependsOn = item.dependsOn;
    if (typeof id !== "string" || !id.trim() || ids.has(id)) throw new Error("Planner returned an invalid or duplicate step id");
    if (typeof agent !== "string" || !allowedAgents.has(agent)) throw new Error("Planner selected an unavailable agent: " + String(agent));
    if (typeof input !== "string" || !input.trim()) throw new Error("Planner returned an invalid step input");
    if (dependsOn !== undefined && (!Array.isArray(dependsOn) || dependsOn.some((x) => typeof x !== "string"))) {
      throw new Error("Planner returned invalid dependencies");
    }
    ids.add(id);
    result.push({ id, agent, input, ...(dependsOn ? { dependsOn } : {}) });
  }
  return { steps: result };
}

export function createWohoAgentPlatform(options: WohoAgentPlatformOptions = {}): WohoAgentPlatform {
  const registry = options.registry ?? new AgentRegistry();
  const runtime = new AgentRuntime(options.runtime, registry);
  const commonTools = [...(options.commonTools ?? [])];
  const maxPlanSteps = options.maxPlanSteps ?? 16;
  const maxPlanGoalBytes = options.maxPlanGoalBytes ?? 256 * 1024;
  if (!Number.isInteger(maxPlanSteps) || maxPlanSteps < 1) throw new Error("maxPlanSteps must be a positive integer");
  if (!Number.isInteger(maxPlanGoalBytes) || maxPlanGoalBytes < 1) throw new Error("maxPlanGoalBytes must be a positive integer");

  for (const role of ROLES) {
    const id = agentId(role);
    if (registry.get(id)) continue;
    const tools = [...commonTools, ...(options.toolsByRole?.[role] ?? [])];
    registry.register({
      id,
      name: `WoHo ${role[0]!.toUpperCase() + role.slice(1)} Agent`,
      role,
      instructions: ROLE_INSTRUCTIONS[role],
      tools,
      capabilities: [role],
      permissions: options.permissionsByRole?.[role],
    }, ({ ai, definition }) => {
      const finalTools = definition.id === agentId("orchestrator")
        ? [...(definition.tools ?? []), createAgentDelegationTool(runtime, ai, registry, options.delegation)]
        : definition.tools;
      return new Agent(ai, {
        name: definition.name,
        role: definition.role,
        instructions: definition.instructions,
        tools: finalTools,
        capabilities: definition.capabilities,
        permissions: definition.permissions,
      });
    });
  }

  const allowedAgents = new Set(registry.list().map((definition) => definition.id));

  const plan = async (ai: AIClient, goal: string, planOptions: { signal?: AbortSignal } = {}): Promise<AgentPlan> => {
    if (!goal.trim()) throw new Error("Goal is required");
    if (Buffer.byteLength(goal, "utf8") > maxPlanGoalBytes) throw new Error("Goal exceeds maxPlanGoalBytes");
    const response = await ai.chat({
      messages: [
        { role: "system", content:
          "You are the WoHo planning engine. Return ONLY JSON with shape {"steps":[{"id":"step-1","agent":"woho-coding","input":"...","dependsOn":[]}]}." +
          " Use only the supplied agent IDs. Keep the plan minimal, ordered, independently verifiable, and never claim an unavailable capability." },
        { role: "user", content: "Available agents: " + [...allowedAgents].join(", ") + "\nGoal:\n" + goal },
      ],
      signal: planOptions.signal,
    });
    return validatePlan(extractJson(response.text), allowedAgents, maxPlanSteps);
  };

  const runPlan = (ai: AIClient, agentPlan: AgentPlan, runOptions: { signal?: AbortSignal } = {}) =>
    runAgentPlan(runtime, ai, agentPlan, runOptions);

  const run = async (ai: AIClient, goal: string, runOptions: { signal?: AbortSignal; agent?: string } = {}) => {
    const agent = runOptions.agent ?? agentId("orchestrator");
    if (!registry.get(agent)) throw new Error("Unknown orchestration agent: " + agent);
    const agentPlan = await plan(ai, goal, runOptions);
    return runPlan(ai, agentPlan, runOptions);
  };

  return { registry, runtime, plan, runPlan, run, runAgent: (ai, task) => runtime.run(ai, task) };
}

