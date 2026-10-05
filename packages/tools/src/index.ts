import type { AgentTool } from "@woho/agents";

export interface ToolSecurityPolicy {
  allowedHosts?: string[];
  allowedDirectories?: string[];
  maxResponseBytes?: number;
  maxFileBytes?: number;
  timeoutMs?: number;
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
      if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) throw new Error("Invalid expression");
      if (!/^[0-9+\-*/().%\s]+$/.test(value)) throw new Error("Only basic arithmetic is allowed");
      const result = Function('"use strict"; return (' + value.replace(/%/g, "/100") + ')')();
      if (typeof result !== "number" || !Number.isFinite(result)) throw new Error("Expression did not produce a finite number");
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
      const text = requireObject(input).text;
      if (typeof text !== "string") throw new Error("text is required");
      return { length: text.length };
    },
  };
}

function hostAllowed(host: string, allowedHosts?: string[]): boolean {
  if (!allowedHosts?.length) return false;
  return allowedHosts.some((allowed) => host === allowed || host.endsWith("." + allowed));
}

export function httpGetTool(policy: ToolSecurityPolicy): AgentTool {
  const timeoutMs = policy.timeoutMs ?? 10_000;
  const maxBytes = policy.maxResponseBytes ?? 1_000_000;
  return {
    name: "http_get",
    description: "Fetch a URL only when its hostname is explicitly allowed by the application policy.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    async execute(input) {
      const urlText = requireObject(input).url;
      if (typeof urlText !== "string") throw new Error("url is required");
      const url = new URL(urlText);
      if (url.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
      if (!hostAllowed(url.hostname, policy.allowedHosts)) throw new Error("Host is not allowed by policy");

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: "error" });
        const contentLength = Number(response.headers.get("content-length") ?? 0);
        if (contentLength > maxBytes) throw new Error("Response exceeds size limit");
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("Response exceeds size limit");
        return { status: response.status, contentType: response.headers.get("content-type"), text };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function fileReadTool(policy: ToolSecurityPolicy): AgentTool {
  const maxBytes = policy.maxFileBytes ?? 1_000_000;
  return {
    name: "file_read",
    description: "Read a UTF-8 text file only inside an explicitly allowed directory.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(input) {
      const path = requireObject(input).path;
      if (typeof path !== "string") throw new Error("path is required");
      if (!policy.allowedDirectories?.length) throw new Error("No allowed directories configured");
      const fs = await import("node:fs/promises");
      const pathModule = await import("node:path");
      const realPath = await fs.realpath(path);
      const allowed = policy.allowedDirectories.some((dir) => {
        const root = pathModule.resolve(dir);
        const target = pathModule.resolve(realPath);
        return target === root || target.startsWith(root + pathModule.sep);
      });
      if (!allowed) throw new Error("Path is outside the allowed directories");
      const stat = await fs.stat(realPath);
      if (!stat.isFile() || stat.size > maxBytes) throw new Error("File is missing, not a regular file, or too large");
      return { path: realPath, text: await fs.readFile(realPath, "utf8") };
    },
  };
}

export const builtInTools = { calculator: calculatorTool, json: jsonTool, textLength: textLengthTool, httpGet: httpGetTool, fileRead: fileReadTool };
