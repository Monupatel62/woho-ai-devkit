# @woho/memory

In-memory and JSON-file conversation storage with session isolation, search and summarization.

Part of the [WoHo AI DevKit](https://github.com/Monupatel62/woho-ai-devkit).

## Install

```bash
pnpm add @woho/memory
```

## Quick start

```ts
import { createInMemoryStore } from "@woho/memory";

const memory = createInMemoryStore({ maxMessages: 100 });

await memory.add({
  id: "message-1",
  role: "user",
  content: "Remember this",
  timestamp: Date.now(),
});

console.log(await memory.list());
```

Use `createJsonFileStore` when conversation state must persist on disk.

## License

Apache-2.0
