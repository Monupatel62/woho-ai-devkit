export type CapabilityKind =
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
  | "data";

export type PermissionAction = "read" | "write" | "execute" | "network" | "communicate" | "call";

export interface Capability {
  readonly name: string;
  readonly kind: CapabilityKind;
  readonly actions: readonly PermissionAction[];
  readonly description?: string;
}

export interface PermissionRequest {
  readonly capability: string;
  readonly action: PermissionAction;
  readonly resource?: string;
  readonly reason?: string;
}

export interface PermissionDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly requiresApproval?: boolean;
}

export interface PermissionPolicy {
  check(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision>;
}

export interface ExecutionContext {
  readonly runId: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly parentRunId?: string;
  readonly signal?: AbortSignal;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly permissions?: PermissionPolicy;
}

export type ExecutionStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface ExecutionEvent {
  readonly type: "run.started" | "run.waiting" | "run.completed" | "run.failed" | "run.cancelled" | "tool.started" | "tool.completed";
  readonly runId: string;
  readonly timestamp: number;
  readonly data?: Readonly<Record<string, unknown>>;
}
