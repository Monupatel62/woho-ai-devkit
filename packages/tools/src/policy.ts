export interface ToolPolicy {
  allowedHosts: string[];
  allowedDirectories: string[];
  maxResponseBytes: number;
  maxFileBytes: number;
  timeoutMs: number;
  allowPrivateAddresses: boolean;
}

export const defaultToolPolicy: ToolPolicy = {
  allowedHosts: [],
  allowedDirectories: [],
  maxResponseBytes: 1_000_000,
  maxFileBytes: 1_000_000,
  timeoutMs: 10_000,
  allowPrivateAddresses: false,
};

function positiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(name + " must be a positive integer");
}

function cleanList(values: string[], name: string, normalizeHost = false): string[] {
  if (!Array.isArray(values)) throw new Error(name + " must be an array");
  return values.map((value) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(name + " entries must be non-empty strings");
    const cleaned = value.trim();
    return normalizeHost ? cleaned.toLowerCase().replace(/\.+$/, "") : cleaned;
  });
}

export function createToolPolicy(input: Partial<ToolPolicy> = {}): ToolPolicy {
  if (input.maxResponseBytes !== undefined) positiveInteger(input.maxResponseBytes, "maxResponseBytes");
  if (input.maxFileBytes !== undefined) positiveInteger(input.maxFileBytes, "maxFileBytes");
  if (input.timeoutMs !== undefined) positiveInteger(input.timeoutMs, "timeoutMs");
  if (input.allowPrivateAddresses !== undefined && typeof input.allowPrivateAddresses !== "boolean") throw new Error("allowPrivateAddresses must be a boolean");
  return {
    allowedHosts: cleanList(input.allowedHosts ?? defaultToolPolicy.allowedHosts, "allowedHosts", true),
    allowedDirectories: cleanList(input.allowedDirectories ?? defaultToolPolicy.allowedDirectories, "allowedDirectories"),
    maxResponseBytes: input.maxResponseBytes ?? defaultToolPolicy.maxResponseBytes,
    maxFileBytes: input.maxFileBytes ?? defaultToolPolicy.maxFileBytes,
    timeoutMs: input.timeoutMs ?? defaultToolPolicy.timeoutMs,
    allowPrivateAddresses: input.allowPrivateAddresses ?? defaultToolPolicy.allowPrivateAddresses,
  };
}

export function assertAllowedHost(host: string, allowedHosts: string[]): void {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) throw new Error("Host is required");
  if (!allowedHosts.some((allowed) => {
    const entry = allowed.trim().toLowerCase().replace(/\.$/, "");
    return normalized === entry || normalized.endsWith("." + entry);
  })) throw new Error("Host is not allowed by policy");
}
