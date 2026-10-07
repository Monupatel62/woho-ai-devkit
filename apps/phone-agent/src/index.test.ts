import assert from "node:assert/strict";
import { AuthorizedPhoneActionExecutor, PhonePermissionEngine } from "./index.js";

const permissions = new PhonePermissionEngine([
  { capability: "app.launch", allowed: true, apps: ["com.example.allowed"] },
  { capability: "message.send", allowed: true, apps: ["com.example.chat"], requiresApproval: true },
]);

let executed = 0;
let lastAction: unknown;
const executor = new AuthorizedPhoneActionExecutor(permissions, {
  async execute(action) {
    executed += 1;
    lastAction = action;
    return "ok";
  },
});

await assert.rejects(
  executor.execute({
    capability: "app.launch",
    appPackage: "com.example.denied",
    description: "Launch denied app",
  }),
  /No explicit permission granted/,
);
assert.equal(executed, 0);

await assert.rejects(
  executor.execute({
    capability: "message.send",
    appPackage: "com.example.chat",
    description: "Send message",
  }),
  /Owner approval required/,
);
assert.equal(executed, 0);

const result = await executor.execute(
  {
    capability: "message.send",
    appPackage: "com.example.chat",
    description: "Send message",
  },
  { approve: async () => true },
);
assert.equal(result, "ok");
assert.equal(executed, 1);

const mutableNestedAction = {
  capability: "message.send" as const,
  appPackage: "com.example.chat",
  description: "Send message",
  input: { text: "approved", nested: { value: 1 } },
};
let releaseNestedApproval!: () => void;
const nestedApprovalStarted = new Promise<void>((resolve) => { releaseNestedApproval = resolve; });
const nestedApproval = executor.execute(mutableNestedAction, { approve: async () => { await nestedApprovalStarted; return true; } });
mutableNestedAction.input!.text = "tampered";
(mutableNestedAction.input!.nested as { value: number }).value = 99;
releaseNestedApproval();
await assert.doesNotReject(() => nestedApproval);
assert.deepEqual((lastAction as { input: typeof mutableNestedAction.input }).input, { text: "approved", nested: { value: 1 } });

const mutableAction = { capability: "message.send" as const, appPackage: "com.example.chat", description: "Send message" };
let releaseApproval!: () => void;
const approvalStarted = new Promise<void>((resolve) => { releaseApproval = resolve; });
const approval = executor.execute(mutableAction, { approve: async () => { await approvalStarted; return true; } });
mutableAction.capability = "device.action" as never;
releaseApproval();
await assert.doesNotReject(() => approval);
assert.equal((lastAction as { capability: string }).capability, "message.send");

console.log("phone-agent permission tests passed");
