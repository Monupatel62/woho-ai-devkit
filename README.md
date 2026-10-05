# WoHo AI DevKit

Open-source AI developer toolkit for TypeScript and JavaScript.

## What is included

- **@woho/core** — provider-independent AI client, retries, timeouts, cancellation, streaming, validation, errors and observability.
- **@woho/provider-openai** — OpenAI-compatible HTTP and SSE provider.
- **@woho/agents** — multi-agent runtime with registries, specialized roles, dependency-aware plans, retries, execution history, approval hooks, tool events, context limits, memory and MCP bridging.
- **@woho/tools** — calculator, JSON, text, HTTP, file, search, secure workspace and constrained Git tools with explicit security policies.
- **@woho/memory** — in-memory and JSON-file conversation storage, ranked search, semantic embedding search, session isolation and summarization.
- **@woho/mcp** — MCP server/client primitives, resources, prompts, security controls and stdio transport.

## Install

```bash
pnpm install
```

During development, workspace packages are available directly. Published packages are installed individually, for example: `pnpm add @woho/core @woho/provider-openai`.

## Quick start

```ts
import { createAI, createMockProvider } from "@woho/core";

const ai = createAI({
  provider: createMockProvider({ response: "Hello from WoHo AI DevKit" }),
});

const result = await ai.chat({
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result.text);
```

For a real OpenAI-compatible provider:

```ts
import { createAI } from "@woho/core";
import { createOpenAIProvider } from "@woho/provider-openai";

const ai = createAI({
  provider: createOpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    defaultModel: "gpt-4o-mini",
  }),
});

const result = await ai.chat({
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result.text);
```

## Development

```bash
pnpm typecheck
pnpm build
pnpm test
```

## Project structure

- `packages/core`
- `packages/provider-openai`
- `packages/agents`
- `packages/tools`
- `packages/memory`
- `packages/mcp`
- `examples`
- `docs`

## Execution platform

The runtime follows **Plan → Execute → Observe → Verify → Recover → Complete**. Workspace and Git action tools now provide the first bounded project-execution layer beneath that runtime. It provides model routing, multi-agent execution, bounded concurrency, retryable recovery, human approval, execution history and observable lifecycle/tool events. See `docs/execution-platform.md` for the architecture and production integration contract.

## Status

The six publishable packages are in a verified release-ready state. CI covers Node 20 and 22, typecheck, build, tests, release-graph validation, npm tarball validation, consumer import smoke testing, and CodeQL.

The workspace root is private and the six `@woho/*` packages are the publishable packages. Public npm publishing remains a deliberate release action rather than an automatic step on every push.

## Release

Public npm releases are guarded by GitHub Actions. Publishing a GitHub Release automatically runs the release workflow, which first runs typecheck, build, tests and package metadata validation before publishing the six public packages through npm Trusted Publishing (OIDC). A manual workflow-dispatch path remains available for controlled emergency or recovery runs.

The workspace root is intentionally private; the six `@woho/*` packages are the publishable packages.

## License

Apache-2.0
