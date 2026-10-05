# @woho/core

Provider-independent AI client with retries, timeouts, cancellation, streaming, validation, errors and observability.

Part of the [WoHo AI DevKit](https://github.com/Monupatel62/woho-ai-devkit).

## Install

```bash
pnpm add @woho/core
```

## Quick start

```ts
import { createAI, createMockProvider } from "@woho/core";

const ai = createAI({
  provider: createMockProvider({ response: "Hello from WoHo" }),
});

const result = await ai.chat({
  messages: [{ role: "user", content: "Hello" }],
});

console.log(result.text);
```

For production, provide an AI provider such as `@woho/provider-openai`.

## License

Apache-2.0
