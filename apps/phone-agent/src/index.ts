export type PhoneCapability =
  | "call.make"
  | "call.answer"
  | "call.end"
  | "message.read"
  | "message.send"
  | "contacts.read"
  | "contacts.write"
  | "app.launch"
  | "app.interact"
  | "notification.read"
  | "device.action";

export type PermissionDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reason?: string;
};

export type PermissionRule = {
  capability: PhoneCapability;
  allowed: boolean;
  apps?: string[];
  requiresApproval?: boolean;
};

export type PhoneAction = {
  capability: PhoneCapability;
  appPackage?: string;
  description: string;
  input?: unknown;
};

export class PhonePermissionEngine {
  private readonly rules: PermissionRule[];

  constructor(rules: PermissionRule[] = []) {
    this.rules = rules.map((rule) => ({
      ...rule,
      apps: rule.apps ? [...rule.apps] : undefined,
    }));
  }

  check(action: PhoneAction): PermissionDecision {
    const matches = this.rules.filter((rule) => {
      if (rule.capability !== action.capability) return false;
      if (!rule.apps || rule.apps.length === 0) return true;
      return action.appPackage !== undefined && rule.apps.includes(action.appPackage);
    });

    if (matches.length === 0) {
      return { allowed: false, requiresApproval: false, reason: "No explicit permission granted" };
    }

    const rule = matches[matches.length - 1];
    if (!rule.allowed) {
      return { allowed: false, requiresApproval: false, reason: "Action denied by owner policy" };
    }

    return {
      allowed: true,
      requiresApproval: rule.requiresApproval === true,
    };
  }
}

export interface PhoneActionExecutor {
  execute(action: PhoneAction, signal?: AbortSignal): Promise<unknown>;
}

export class AuthorizedPhoneActionExecutor {
  constructor(
    private readonly permissions: PhonePermissionEngine,
    private readonly executor: PhoneActionExecutor,
  ) {}

  async execute(action: PhoneAction, options: {
    signal?: AbortSignal;
    approve?: () => boolean | Promise<boolean>;
  } = {}): Promise<unknown> {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Action aborted");

    const authorizedAction = Object.freeze({ ...action });
    const decision = this.permissions.check(authorizedAction);
    if (!decision.allowed) throw new Error(decision.reason ?? "Permission denied");

    if (decision.requiresApproval) {
      const approved = await options.approve?.();
      if (!approved) throw new Error("Owner approval required");
    }

    return this.executor.execute(authorizedAction, options.signal);
  }
}

export * from "@woho/agents";
export * from "@woho/core";
export * from "@woho/memory";
