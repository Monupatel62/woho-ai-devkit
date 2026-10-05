import type { AIClient } from "@woho/core";
import type { AgentTool } from "./index.js";

export type AgentRole =
  | "orchestrator"
  | "planner"
  | "calling"
  | "communication"
  | "computer"
  | "browser"
  | "file"
  | "coding"
  | "research"
  | "testing"
  | "security"
  | "git"
  | "documentation"
  | "data"
  | "general";

export interface AgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly role: AgentRole;
  readonly instructions?: string;
  readonly tools?: AgentTool[];
  readonly capabilities?: string[];
  readonly maxSteps?: number;
}

export interface AgentFactoryContext {
  readonly ai: AIClient;
  readonly definition: AgentDefinition;
}

export type AgentFactory = (context: AgentFactoryContext) => Agent;

export interface AgentRegistryEntry {
  readonly definition: AgentDefinition;
  readonly factory: AgentFactory;
}

export class AgentRegistry {
  private readonly entries = new Map<string, AgentRegistryEntry>();

  register(definition: AgentDefinition, factory: AgentFactory): this {
    if (!definition.id.trim()) throw new Error("Agent id is required");
    if (!definition.name.trim()) throw new Error("Agent name is required");
    if (this.entries.has(definition.id)) throw new Error("Duplicate agent id: " + definition.id);
    this.entries.set(definition.id, { definition, factory });
    return this;
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  get(id: string): AgentRegistryEntry | undefined {
    return this.entries.get(id);
  }

  list(): AgentDefinition[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.definition, capabilities: entry.definition.capabilities ? [...entry.definition.capabilities] : undefined }));
  }

  create(id: string, ai: AIClient): Agent {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown agent: " + id);
    return entry.factory({ ai, definition: entry.definition });
  }
}

import type { Agent } from "./index.js";
