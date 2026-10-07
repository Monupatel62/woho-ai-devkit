import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserTools } from "./browser.js";

test("browser tools enforce HTTP(S), host policy, and bounded output", async () => {
  const calls: string[] = [];
  const browser = {
    async open(url: string, options?: { signal?: AbortSignal }) { calls.push(`open:${url}:${options?.signal ? "signal" : "none"}`); return { url, title: "Example", text: "x".repeat(100) }; },
    async click(selector: string, options?: { signal?: AbortSignal }) { calls.push(`click:${selector}:${options?.signal ? "signal" : "none"}`); return { url: selector === "#evil" ? "https://evil.example.net" : "https://example.com", text: "clicked" }; },
    async type(selector: string, text: string, options?: { signal?: AbortSignal }) { calls.push(`type:${selector}:${text}:${options?.signal ? "signal" : "none"}`); return { url: "https://example.com" }; },
    async close(options?: { signal?: AbortSignal }) { calls.push(`close:${options?.signal ? "signal" : "none"}`); },
  };
  const tools = createBrowserTools(browser, { allowedHosts: ["example.com"], maxTextChars: 10 });
  assert.equal(tools.length, 4);
  const controller = new AbortController();
  const page = await tools[0].execute({ url: "https://example.com/path" }, { signal: controller.signal });
  assert.equal((page as { text?: string }).text?.length, 10);
  await assert.rejects(() => tools[0].execute({ url: "https://evil.example.net" }));
  await assert.rejects(() => tools[0].execute({ url: "file:///tmp/x" }));
  await tools[1].execute({ selector: "#go" }, { signal: controller.signal });
  await assert.rejects(() => tools[1].execute({ selector: "#evil" }, { signal: controller.signal }), /Browser host is not allowed/); await tools[2].execute({ selector: "#q", text: "hello" }, { signal: controller.signal }); await tools[3].execute({}, { signal: controller.signal });
  assert.deepEqual(calls, ["open:https://example.com/path:signal", "click:#go:signal", "click:#evil:signal", "type:#q:hello:signal", "close:signal"]);
});
