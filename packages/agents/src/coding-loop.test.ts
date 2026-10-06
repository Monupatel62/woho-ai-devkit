import assert from "node:assert/strict";
import { runCodingLoop } from "./coding-loop.js";
let runs=0;
const ai={chat:async()=>({id:"verify",model:"test",text:runs<2?"FAIL: tests failed":"PASS: verified"})};
const result=await runCodingLoop(ai as never,async()=>({text:`attempt-${++runs}`,steps:1,messages:[],toolResults:{}}),{goal:"fix code",verify:"tests pass"},{maxAttempts:3});
assert.equal(result.attempts,2);
assert.equal(runs,2);
console.log("coding loop tests passed");
