import { createAI, createMockProvider } from "@woho/core";
import { createAgent } from "@woho/agents";

const ai = createAI({ provider: createMockProvider({ response: "Agent is ready." }) });
const agent = createAgent(ai, {
  name: "woho-demo",
  instructions: "Answer clearly and briefly.",
});

const result = await agent.run("Hello");
console.log(result.text);