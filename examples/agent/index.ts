import { createAI, createMockProvider } from "@woho/core";
import { createAgent } from "@woho/agents";

const ai = createAI({
  provider: createMockProvider({
    response: "The calculator tool returned 42.",
    toolCall: { name: "calculator", arguments: JSON.stringify({ expression: "6 * 7" }) },
  }),
});

const agent = createAgent(ai, {
  name: "woho-calculator",
  instructions: "Use the calculator tool for arithmetic.",
  tools: [{
    name: "calculator",
    description: "Calculate a mathematical expression.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
      additionalProperties: false,
    },
    async execute(input) {
      const expression = typeof input === "object" && input !== null && "expression" in input
        ? String((input as { expression: unknown }).expression)
        : "";
      return { expression, result: 42 };
    },
  }],
});

const result = await agent.run("What is 6 * 7?");
console.log(result.text);
console.log("steps:", result.steps);
