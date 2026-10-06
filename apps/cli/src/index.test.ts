import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./index.js";

test("--help is available without an API key", async () => {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await runCli(["--help"]), 0);
    assert.match(output, /WoHo AI CLI/);
    assert.match(output, /read-only|read only/);
  } finally { process.stdout.write = original; }
});

test("missing API key returns a controlled exit code", async () => {
  const key = process.env.OPENAI_API_KEY;
  const original = process.stderr.write;
  let output = "";
  delete process.env.OPENAI_API_KEY;
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    assert.equal(await runCli(["analyze", "the", "project"]), 2);
    assert.match(output, /OPENAI_API_KEY is required/);
  } finally {
    if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key;
    process.stderr.write = original;
  }
});

test("empty invocation prints help", async () => {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    assert.equal(await runCli([]), 0);
    assert.match(output, /Usage:/);
  } finally { process.stdout.write = original; }
});
