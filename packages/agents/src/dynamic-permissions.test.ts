import assert from "node:assert/strict";
import { createAI, createMockProvider } from "@woho/core";
import { createAgent } from "./index.js";

const ai = createAI({
  provider: createMockProvider({
    response: "ok",
    toolCall: { name: "dynamic", arguments: JSON.stringify({ operation: "write", path: "src/app.ts" }) },
  }),
});

const requests: Array<{ capability: string; action: string; resource?: string }> = [];
const agent = createAgent(ai, {
  name: "dynamic-permission-test",
  permissions: {
    check(request) {
      requests.push(request);
      return { allowed: request.action === "write" && request.resource === "src/app.ts" };
    },
  },
  tools: [{
    name: "dynamic",
    description: "Test dynamic authorization",
    capability: "file",
    action: "read",
    parameters: { type: "object" },
    authorize(input) {
      const value = input as { operation: string; path: string };
      return {
        capability: "file",
        action: value.operation === "write" ? "write" : "read",
        resource: value.path,
      };
    },
    async execute() {
      return { ok: true };
    },
  }],
  maxSteps: 3,
});

const result = await agent.run("write");
assert.equal(result.text, "ok");
assert.deepEqual(requests, [{ capability: "file", action: "write", resource: "src/app.ts" }]);
console.log("dynamic permission tests passed");
