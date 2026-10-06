import { randomUUID } from "node:crypto";

export interface WohoProjectContextOptions {
  readonly projectId?: string;
  readonly root: string;
  readonly sessionId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly maxMetadataBytes?: number;
}

export interface WohoProjectContext {
  readonly projectId: string;
  readonly root: string;
  readonly sessionId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

const DEFAULT_MAX_METADATA_BYTES = 16 * 1024;

function boundedMetadata(metadata: Record<string, unknown>, maxBytes: number): Readonly<Record<string, unknown>> {
  let json: string;
  try {
    json = JSON.stringify(metadata);
  } catch {
    throw new Error("Project metadata must be JSON-serializable");
  }
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new Error("Project metadata exceeds maxMetadataBytes");
  }
  return Object.freeze({ ...metadata });
}

export function createWohoProjectContext(options: WohoProjectContextOptions): WohoProjectContext {
  if (!options.root.trim()) throw new Error("Project root is required");
  const projectId = options.projectId?.trim() || `project-${randomUUID()}`;
  const sessionId = options.sessionId?.trim() || `session-${randomUUID()}`;
  const maxMetadataBytes = options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
  if (!Number.isInteger(maxMetadataBytes) || maxMetadataBytes < 1) {
    throw new Error("maxMetadataBytes must be a positive integer");
  }
  return Object.freeze({
    projectId,
    root: options.root,
    sessionId,
    metadata: boundedMetadata({
      projectId,
      projectRoot: options.root,
      ...(options.metadata ?? {}),
    }, maxMetadataBytes),
  });
}

export function mergeWohoProjectMetadata(
  context: WohoProjectContext,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...context.metadata,
    ...(metadata ?? {}),
    projectId: context.projectId,
    projectRoot: context.root,
  };
}
