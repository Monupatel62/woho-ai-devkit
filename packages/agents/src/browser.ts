import type { AgentTool, AgentRunOptions } from "./index.js";

export interface BrowserPage { readonly url: string; readonly title?: string; readonly text?: string; }
export interface BrowserClient {
  open(url: string, options?: AgentRunOptions): Promise<BrowserPage>;
  click(selector: string, options?: AgentRunOptions): Promise<BrowserPage>;
  type(selector: string, text: string, options?: AgentRunOptions): Promise<BrowserPage>;
  close(options?: AgentRunOptions): Promise<void>;
}
export interface BrowserPolicy { readonly allowedHosts?: readonly string[]; readonly maxTextChars?: number; }

function assertUrlAllowed(url: string, allowedHosts?: readonly string[]): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid browser URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Browser only permits HTTP(S) URLs");
  if (!allowedHosts?.length) return;
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.some((allowed) => host === allowed.toLowerCase() || host.endsWith(`.${allowed.toLowerCase()}`))) throw new Error("Browser host is not allowed");
}
function boundPage(page: BrowserPage, maxTextChars: number): BrowserPage { return { ...page, text: page.text?.slice(0, maxTextChars) }; }

export function createBrowserTools(browser: BrowserClient, policy: BrowserPolicy = {}): AgentTool[] {
  const maxTextChars = policy.maxTextChars ?? 30_000;
  if (!Number.isInteger(maxTextChars) || maxTextChars < 1) throw new Error("maxTextChars must be a positive integer");
  const open: AgentTool = {
    name: "browser_open", description: "Open an authorized HTTP(S) URL and return bounded page information.", capability: "browser", action: "read",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
    async execute(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const url = (input as Record<string, unknown>).url;
      if (typeof url !== "string" || !url.trim()) throw new Error("url is required");
      assertUrlAllowed(url, policy.allowedHosts);
      return boundPage(await browser.open(url, { signal: context?.signal, runId: context?.runId }), maxTextChars);
    },
  };
  const click: AgentTool = {
    name: "browser_click", description: "Click an element in the current authorized browser session.", capability: "browser", action: "execute",
    parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"], additionalProperties: false },
    async execute(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const selector = (input as Record<string, unknown>).selector;
      if (typeof selector !== "string" || !selector.trim()) throw new Error("selector is required");
      return boundPage(await browser.click(selector, { signal: context?.signal, runId: context?.runId }), maxTextChars);
    },
  };
  const type: AgentTool = {
    name: "browser_type", description: "Type text into an element in the current authorized browser session.", capability: "browser", action: "execute",
    parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"], additionalProperties: false },
    async execute(input, context) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
      const value = input as Record<string, unknown>;
      if (typeof value.selector !== "string" || !value.selector.trim()) throw new Error("selector is required");
      if (typeof value.text !== "string") throw new Error("text is required");
      return boundPage(await browser.type(value.selector, value.text, { signal: context?.signal, runId: context?.runId }), maxTextChars);
    },
  };
  const close: AgentTool = {
    name: "browser_close", description: "Close the current browser session.", capability: "browser", action: "execute",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) { await browser.close({ signal: context?.signal, runId: context?.runId }); return { closed: true }; },
  };
  return [open, click, type, close];
}
