import { randomUUID } from "node:crypto";
import type { AIClient, ExecutionContext, ExecutionEvent } from "@woho/core";
import { Agent, type AgentOptions, type AgentRunResult } from "./index.js";
import { AgentRegistry, type AgentDefinition } from "./definition.js";

export interface AgentRuntimeOptions {
  readonly maxConcurrency?: number;
  readonly onEvent?: (event: ExecutionEvent) => void | Promise<void>;
}

export interface AgentTask {
  readonly agent: string;
  readonly input: string;
  readonly parentRunId?: string;
  readonly sessionId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export class AgentRuntime {
  readonly registry: AgentRegistry;
  private readonly maxConcurrency: number;
  private readonly onEvent?: AgentRuntimeOptions["onEvent"];
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: AgentRuntimeOptions = {}, registry = new AgentRegistry()) {
    this.registry = registry;
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.onEvent = options.onEvent;
    if (!Number.isInteger(this.maxConcurrency) || this.maxConcurrency < 1) throw new Error("maxConcurrency must be a positive integer");
  }

  register(definition: AgentDefinition, factory?: (ai: AIClient, definition: AgentDefinition) => Agent): this {
    const creator = factory ?? ((ai, item) => new Agent(ai, {
      name: item.name,
      instructions: item.instructions,
      tools: item.tools,
      maxSteps: item.maxSteps,
    }));
    this.registry.register(definition, ({ ai }) => creator(ai, definition));
    return this;
  }

  async run(ai: AIClient, task: AgentTask): Promise<AgentRunResult & { runId: string }> {
    const runId = randomUUID();
    await this.acquire();
    const context: ExecutionContext = {
      runId,
      sessionId: task.sessionId,
      parentRunId: task.parentRunId,
      signal: task.signal,
      metadata: task.metadata ?? {},
    };
    await this.emit({ type: "run.started", runId, timestamp: Date.now(), data: { agent: task.agent, sessionId: task.sessionId } });
    try {
      if (task.signal?.aborted) throw task.signal.reason ?? new Error("Aborted");
      const agent = this.registry.create(task.agent, ai);
      const result = await agent.run(task.input, { signal: context.signal });
      await this.emit({ type: "run.completed", runId, timestamp: Date.now(), data: { agent: task.agent, steps: result.steps } });
      return { ...result, runId };
    } catch (error) {
      if (task.signal?.aborted) {
        await this.emit({ type: "run.cancelled", runId, timestamp: Date.now(), data: { agent: task.agent } });
      } else {
        await this.emit({ type: "run.failed", runId, timestamp: Date.now(), data: { agent: task.agent, error: error instanceof Error ? error.message : String(error) } });
      }
      throw error;
    } finally {
      this.release();
    }
  }

  async runParallel(ai: AIClient, tasks: AgentTask[]): Promise<Array<AgentRunResult & { runId: string }>> {
    return Promise.all(tasks.map((task) => this.run(ai, task)));
  }

  private async emit(event: ExecutionEvent): Promise<void> {
    await this.onEvent?.(event);
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}
