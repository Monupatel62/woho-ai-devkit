# @woho/tools

Security-focused reusable tools including calculator, JSON, text, HTTP, file and search tools.

Part of the [WoHo AI DevKit](https://github.com/Monupatel62/woho-ai-devkit).

## Install

```bash
pnpm add @woho/tools @woho/agents
```

## Quick start

```ts
import { builtInTools } from "@woho/tools";

const result = await builtInTools.calculator.execute({
  expression: "12 * 8",
});

console.log(result);
```

HTTP and file tools require explicit security policy configuration. Search tools use provider adapters and bounded result limits.

## License

Apache-2.0
