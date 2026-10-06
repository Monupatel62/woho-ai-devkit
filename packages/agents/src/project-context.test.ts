import assert from "node:assert/strict";
import { createWohoProjectContext, mergeWohoProjectMetadata } from "./project-context.js";

const context = createWohoProjectContext({
  projectId: "demo",
  root: "/workspace/demo",
  sessionId: "session-1",
  metadata: { branch: "main" },
});
assert.equal(context.projectId, "demo");
assert.equal(context.root, "/workspace/demo");
assert.equal(context.sessionId, "session-1");
assert.equal(context.metadata.branch, "main");
assert.equal(context.metadata.projectId, "demo");
assert.equal(context.metadata.projectRoot, "/workspace/demo");

const merged = mergeWohoProjectMetadata(context, { branch: "feature", task: "fix" });
assert.deepEqual(merged, {
  projectId: "demo",
  projectRoot: "/workspace/demo",
  branch: "feature",
  task: "fix",
});
assert.throws(() => createWohoProjectContext({ root: "" }), /Project root is required/);
assert.throws(() => createWohoProjectContext({ root: "/workspace/demo", metadata: { value: "x".repeat(100) }, maxMetadataBytes: 10 }), /maxMetadataBytes/);
assert.throws(() => createWohoProjectContext({ root: "/workspace/demo", metadata: { value: 1n }, maxMetadataBytes: 100 }), /JSON-serializable/);
console.log("project context tests passed");
