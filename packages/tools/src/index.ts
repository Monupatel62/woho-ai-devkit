import type { AgentTool } from "@woho/agents";
import { validateToolInput } from "./validation.js";
export { ToolRegistry, createToolRegistry } from "./registry.js";
export { commandTool, type CommandToolPolicy } from "./command.js";
export { gitTool, type GitToolPolicy } from "./git.js";
export { workspaceTool, createWorkspaceTool, type WorkspaceToolPolicy, type WorkspaceEntry } from "./workspace.js";
export { createProjectTools, type ProjectToolsPolicy } from "./project.js";
export { validateToolInput } from "./validation.js";
import { assertAllowedHost, createToolPolicy, type ToolPolicy } from "./policy.js";
export { createSearchProvider, searchTool, type SearchProvider, type SearchResult, type SearchToolPolicy } from "./search.js";
export { createBraveSearchProvider, createTavilySearchProvider, type SearchProviderOptions } from "./search-providers.js";

export type ToolSecurityPolicy = Partial<ToolPolicy>;

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("Response body is unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let received = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("Response exceeds size limit");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function requireObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
  return input as Record<string, unknown>;
}

export function calculatorTool(): AgentTool {
  return {
    name: "calculator",
    description: "Evaluate basic arithmetic expressions without network or filesystem access.",
    parameters: { type: "object", properties: { expression: { type: "string" } }, required: ["expression"], additionalProperties: false },
    async execute(input) {
      const value = requireObject(input).expression;
      validateToolInput({ type: "object", properties: { expression: { type: "string" } }, required: ["expression"], additionalProperties: false }, input);
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) throw new Error("Invalid expression");
      if (!/^[0-9+\-*/().%\s]+$/.test(value)) throw new Error("Only basic arithmetic is allowed");
      const tokens = value.match(/\d+(?:\.\d+)?|[()+\-*/%]/g) ?? [];
      if (tokens.join("") !== value.replace(/\s+/g, "")) throw new Error("Invalid expression");
      const values: number[] = [];
      const operators: string[] = [];
      const precedence = (operator: string) => operator === "+" || operator === "-" ? 1 : 2;
      const apply = () => {
        const operator = operators.pop();
        if (!operator) throw new Error("Invalid expression");
        const right = values.pop();
        const left = values.pop();
        if (left === undefined || right === undefined) throw new Error("Invalid expression");
        let result: number;
        if (operator === "+") result = left + right;
        else if (operator === "-") result = left - right;
        else if (operator === "*") result = left * right;
        else if (operator === "/") result = left / right;
        else result = left % right;
        if (!Number.isFinite(result)) throw new Error("Expression did not produce a finite number");
        values.push(result);
      };
      let previous: "value" | "operator" | "open" = "operator";
      for (const token of tokens) {
        if (/^\\d/.test(token)) {
          if (previous === "value") throw new Error("Invalid expression");
          values.push(Number(token));
          previous = "value";
        } else if (token === "(") {
          if (previous === "value") throw new Error("Invalid expression");
          operators.push(token);
          previous = "open";
        } else if (token === ")") {
          if (previous !== "value") throw new Error("Invalid expression");
          while (operators.at(-1) !== "(") apply();
          operators.pop();
          previous = "value";
        } else {
          if (previous !== "value" && !(token === "-" && (previous === "operator" || previous === "open"))) throw new Error("Invalid expression");
          if (token === "-" && previous !== "value") values.push(0);
          else while (operators.at(-1) !== "(" && operators.length && precedence(operators.at(-1)!) >= precedence(token)) apply();
          operators.push(token);
          previous = "operator";
        }
      }
      if (previous !== "value") throw new Error("Invalid expression");
      while (operators.length) {
        if (operators.at(-1) === "(") throw new Error("Invalid expression");
        apply();
      }
      const result = values.length === 1 ? values[0] : NaN;
      if (!Number.isFinite(result)) throw new Error("Expression did not produce a finite number");
      return { expression: value, result };
    },
  };
}

export function jsonTool(): AgentTool {
  return {
    name: "json",
    description: "Parse JSON text and return the parsed value.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    async execute(input) {
      validateToolInput({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, input);
      const text = requireObject(input).text;
      if (typeof text !== "string" || text.length > 100_000) throw new Error("Invalid or oversized JSON input");
      return JSON.parse(text);
    },
  };
}

export function textLengthTool(): AgentTool {
  return {
    name: "text_length",
    description: "Return the character length of text.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    async execute(input) {
      validateToolInput({ type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, input);
      const text = requireObject(input).text;
      if (typeof text !== "string") throw new Error("text is required");
      return { length: text.length };
    },
  };
}

export function httpGetTool(inputPolicy: ToolSecurityPolicy = {}): AgentTool {
  const policy = createToolPolicy(inputPolicy);
  return {
    name: "http_get",
    description: "Fetch a URL only when its hostname is explicitly allowed by the application policy.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    async execute(input) {
      const urlText = requireObject(input).url;
      if (typeof urlText !== "string") throw new Error("url is required");
      const url = new URL(urlText);
      if (url.username || url.password) throw new Error("Credential-bearing URLs are not allowed");
      if (url.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
      assertAllowedHost(url.hostname, policy.allowedHosts);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: "error", headers: { accept: "text/plain, application/json, text/*;q=0.9" } });
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (contentLength > policy.maxResponseBytes) throw new Error("Response exceeds size limit");
        const text = await readResponseTextWithLimit(response, policy.maxResponseBytes);
        return { status: response.status, contentType: response.headers.get("content-type"), text };
      } finally { clearTimeout(timer); }
    },
  };
}

export function fileReadTool(inputPolicy: ToolSecurityPolicy = {}): AgentTool {
  const policy = createToolPolicy(inputPolicy);
  return {
    name: "file_read",
    description: "Read a UTF-8 text file only inside an explicitly allowed directory.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(input) {
      const path = requireObject(input).path;
      if (typeof path !== "string") throw new Error("path is required");
      if (!policy.allowedDirectories.length) throw new Error("No allowed directories configured");
      const fs = await import("node:fs/promises");
      const pathModule = await import("node:path");
      const realPath = await fs.realpath(path);
      const target = pathModule.resolve(realPath);
      const allowed = await (async () => {
        for (const dir of policy.allowedDirectories) {
          try {
            const root = pathModule.resolve(await fs.realpath(dir));
            if (target === root || target.startsWith(root + pathModule.sep)) return true;
          } catch {}
        }
        return false;
      })();
      if (!allowed) throw new Error("Path is outside the allowed directories");
      const stat = await fs.stat(realPath);
      if (!stat.isFile() || stat.size > policy.maxFileBytes) throw new Error("File is missing, not a regular file, or too large");
      return { path: realPath, text: await fs.readFile(realPath, "utf8") };
    },
  };
}

export { assertAllowedHost, createToolPolicy, defaultToolPolicy } from "./policy.js";
export type { ToolPolicy } from "./policy.js";
export const builtInTools = { calculator: calculatorTool, json: jsonTool, textLength: textLengthTool, httpGet: httpGetTool, fileRead: fileReadTool };