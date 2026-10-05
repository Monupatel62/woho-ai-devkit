import type { AIClient } from "@woho/core";
import { Agent } from "./index.js";
import type { AgentTool, AgentOptions } from "./index.js";
import type { AgentRole } from "./definition.js";

export interface CallingAdapter {
  placeCall(target: string, options?: Record<string, unknown>): Promise<{ callId: string }>;
  answerCall(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
  sendText?(callId: string, text: string): Promise<void>;
}

export interface ComputerAdapter {
  openApplication(name: string): Promise<unknown>;
  closeApplication(name: string): Promise<unknown>;
  observe(): Promise<unknown>;
}

export interface BrowserAdapter {
  navigate(url: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  type(selector: string, text: string): Promise<unknown>;
  observe(): Promise<unknown>;
}

export interface SpecializedAgentOptions extends Omit<AgentOptions, "name" | "role" | "capabilities"> {
  name?: string;
  tools?: AgentTool[];
}

const roleInstructions: Record<AgentRole, string> = {
  orchestrator: "Coordinate work across specialized agents. Break goals into safe, verifiable tasks and delegate when useful.",
  planner: "Turn a user goal into explicit ordered steps, dependencies, risks, and verification criteria.",
  calling: "Handle authorized call workflows, keep conversation state, and never perform an external call without an approved calling capability.",
  communication: "Handle messages and conversations with clear intent, context, and safe external-action boundaries.",
  computer: "Operate an authorized computer environment through explicit tools, observe results, and verify every consequential action.",
  browser: "Navigate and interact with authorized web pages through browser tools while respecting domain and action policies.",
  file: "Inspect and modify authorized files with path restrictions, minimal changes, and verification.",
  coding: "Analyze, modify, build, test, and verify software changes before reporting completion.",
  research: "Gather evidence from authorized sources, distinguish facts from inference, and return traceable findings.",
  testing: "Design and execute focused tests, diagnose failures, and report reproducible evidence.",
  security: "Review code and execution plans for vulnerabilities, unsafe permissions, secrets, and boundary violations.",
  git: "Inspect repository state and perform authorized version-control operations with clear change boundaries.",
  documentation: "Create accurate, maintainable documentation from verified implementation behavior.",
  data: "Transform and analyze authorized data while preserving correctness, provenance, and bounded resource usage.",
  general: "Complete the user's task using available tools, memory, and explicit permissions with verification."
};

export function createSpecializedAgent(ai: AIClient, role: AgentRole, options: SpecializedAgentOptions = {}) {
  const normalized = Array.isArray(options) ? {} : options;
  const name = normalized.name ?? role[0]!.toUpperCase() + role.slice(1) + " Agent";
  return new Agent(ai, {
    ...normalized,
    name,
    role,
    capabilities: [role],
    instructions: [roleInstructions[role], normalized.instructions].filter(Boolean).join("\n\n"),
  });
}

function requireAgent() {
  return class extends (Object as { new (...args: any[]): any }) {
    constructor(...args: any[]) { return new (globalThis as any).__WOHO_AGENT_CONSTRUCTOR(...args); }
  };
}

export { roleInstructions };
