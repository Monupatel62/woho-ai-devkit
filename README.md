# WoHo AI DevKit

Open-source AI developer toolkit for TypeScript and JavaScript.

## Stage 2 — AI Core

The first working runtime layer is now available.

Install from the workspace while developing:

    pnpm install

Use the core API:

    import { createAI } from "@woho/core";

Create a provider and send a request:

    const ai = createAI({ provider });

    const result = await ai.chat({
      messages: [{ role: "user", content: "Hello" }]
    });

The core supports provider-independent types, timeouts, retry handling, cancellation, standardized errors, streaming interfaces, and a mock provider. An OpenAI-compatible provider is included under packages/provider-openai.

## Project structure

- packages/core — runtime and shared AI abstractions
- packages/provider-openai — OpenAI-compatible HTTP provider
- examples/basic-chat — minimal usage example
- docs — project documentation

## Status

Stage 2 is complete at the architecture level and is ready for provider and agent expansion.

## License

Apache-2.0
