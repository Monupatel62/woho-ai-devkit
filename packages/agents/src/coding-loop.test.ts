import assert from "node:assert/strict";
import { runCodingLoop } from "./coding-loop.js";
let runs=0;
const ai={chat:async()=>({id:"verify",model:"test",text:runs<2?"FAIL: tests failed":"PASS: verified"})};
const result=await runCodingLoop(ai as never,async()=>({text:`attempt-${++runs}`,steps:1,messages:[],toolResults:{}}),{goal:"fix code",verify:"tests pass"},{maxAttempts:3});
assert.equal(result.attempts,2);
assert.equal(runs,2);

const evidenceProvider = {
  chat: async (request: { messages: Array<{ role: string; content: string }> }) => {
    const user = request.messages.find((message) => message.role === "user")?.content ?? "";
    if (user.includes("Observed tool evidence:")) {
      assert.match(user, /tool-result-proof/);
      assert.match(user, /agent prose/);
      return { id: "verify-evidence", text: "PASS evidence confirms the observed tool result", model: "evidence-provider" };
    }
    return { id: "agent", text: "agent prose", model: "evidence-provider" };
  },
};
const evidenceResult = await runCodingLoop(
  evidenceProvider as never,
  async () => ({ text: "agent prose", steps: 1, messages: [], toolResults: { proof: "tool-result-proof" } }),
  { goal: "Inspect and verify", verify: "The inspection must be evidenced." },
);
assert.equal(evidenceResult.attempts, 1);

await assert.rejects(
  () => runCodingLoop(
    evidenceProvider as never,
    async () => ({ text: "x", steps: 1, messages: [], toolResults: {} }),
    { goal: "x", verify: "x" },
    { maxVerificationChars: 0 },
  ),
  /maxVerificationChars/,
);
console.log("coding loop tests passed");
