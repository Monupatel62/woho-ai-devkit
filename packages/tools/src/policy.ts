export interface ToolPolicy {
  allowedHosts: string[];
  allowedDirectories: string[];
  maxResponseBytes: number;
  maxFileBytes: number;
  timeoutMs: number;
}

export const defaultToolPolicy: ToolPolicy = {
  allowedHosts: [],
  allowedDirectories: [],
  maxResponseBytes: 1_000_000,
  maxFileBytes: 1_000_000,
  timeoutMs: 10_000,
};

export function createToolPolicy(input: Partial<ToolPolicy> = {}): ToolPolicy {
  if (input.maxResponseBytes !== undefined && input.maxResponseBytes <= 0) throw new Error("maxResponseBytes must be positive");
  if (input.maxFileBytes !== undefined && input.maxFileBytes <= 0) throw new Error("maxFileBytes must be positive");
  if (input.timeoutMs !== undefined && input.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  return {
    allowedHosts: [...(input.allowedHosts ?? defaultToolPolicy.allowedHosts)],
    allowedDirectories: [...(input.allowedDirectories ?? defaultToolPolicy.allowedDirectories)],
    maxResponseBytes: input.maxResponseBytes ?? defaultToolPolicy.maxResponseBytes,
    maxFileBytes: input.maxFileBytes ?? defaultToolPolicy.maxFileBytes,
    timeoutMs: input.timeoutMs ?? defaultToolPolicy.timeoutMs,
  };
}

export function assertAllowedHost(host: string, allowedHosts: string[]): void {
  if (!allowedHosts.some((allowed) => host === allowed || host.endsWith("." + allowed))) {
    throw new Error("Host is not allowed by policy");
  }
}
