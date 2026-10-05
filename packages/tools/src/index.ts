import type { AgentTool } from "@woho/agents";

export interface CalculatorInput { expression: string; }

export function calculatorTool(): AgentTool {
  return {
    name: "calculator",
    description: "Evaluate basic arithmetic expressions without network or filesystem access.",
    parameters: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
      additionalProperties: false,
    },
    async execute(input) {
      if (!input || typeof input !== "object" || !("expression" in input)) throw new Error("expression is required");
      const expression = String((input as CalculatorInput).expression).trim();
      if (!expression || expression.length > 200) throw new Error("Invalid expression");
      if (!/^[0-9+\-*/().%\s]+$/.test(expression)) throw new Error("Only basic arithmetic is allowed");
      const normalized = expression.replace(/%/g, "/100");
      const result = Function('"use strict"; return (' + normalized + ')')();
      if (typeof result !== "number" || !Number.isFinite(result)) throw new Error("Expression did not produce a finite number");
      return { expression, result };
    },
  };
}

export function jsonTool(): AgentTool {
  return {
    name: "json",
    description: "Parse JSON text and return the parsed value.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(input) {
      if (!input || typeof input !== "object" || !("text" in input)) throw new Error("text is required");
      const text = String((input as { text: unknown }).text);
      if (text.length > 100_000) throw new Error("JSON input is too large");
      return JSON.parse(text) as unknown;
    },
  };
}

export function textLengthTool(): AgentTool {
  return {
    name: "text_length",
    description: "Return the character length of text.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(input) {
      if (!input || typeof input !== "object" || !("text" in input)) throw new Error("text is required");
      const text = String((input as { text: unknown }).text);
      return { length: text.length };
    },
  };
}

export const builtInTools = {
  calculator: calculatorTool,
  json: jsonTool,
  textLength: textLengthTool,
};
