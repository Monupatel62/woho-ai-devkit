# @woho/provider-openai

OpenAI-compatible HTTP and SSE provider for WoHo AI DevKit.

Part of the [WoHo AI DevKit](https://github.com/Monupatel62/woho-ai-devkit).

## Install

```bash
pnpm add @woho/provider-openai @woho/core
```

## Quick start

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

The provider supports HTTPS endpoints, configurable response limits, streaming and cancellation. Localhost HTTP is allowed for development.

## License

Apache-2.0
