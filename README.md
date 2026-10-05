# WoHo AI DevKit

Open-source AI developer toolkit for TypeScript and JavaScript.

## What is included

- **@woho/core** — provider-independent AI client, retries, timeouts, cancellation, streaming, validation, errors and observability.
- **@woho/provider-openai** — OpenAI-compatible HTTP and SSE provider.
- **@woho/agents** — tool-calling agents with bounded steps, context limits, memory and MCP tool bridging.
- **@woho/tools** — calculator, JSON, text, HTTP and file tools with security policies plus search-provider abstractions.
- **@woho/memory** — in-memory and JSON-file conversation storage, search, session isolation and summarization.
- **@woho/mcp** — MCP server/client primitives, resources, prompts, security controls and stdio transport.

## Install

```bash
pnpm install
```

During development, workspace packages are available directly. Published package installation will be documented with the first npm release.

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

## Status

Core, agents, tools, memory and MCP foundations are implemented. The project is continuing through final production hardening before the first public npm release. npm package metadata and tarball boundaries are now prepared for release validation.

## Release

Public npm releases are guarded by GitHub Actions. The release workflow first runs typecheck, build, tests and package metadata validation. Publishing is manual and requires the workflow's `publish` input to be enabled in the configured `npm` environment.

The workspace root is intentionally private; the six `@woho/*` packages are the publishable packages.

## License

Apache-2.0
