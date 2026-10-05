# Stage 4 — Reusable Tools

Stage 4 starts the reusable safe-tool layer for WoHo AI DevKit.

## Included

- calculator: basic arithmetic only; no network or filesystem access
- json: bounded JSON parsing
- text_length: deterministic text utility
- JSON-schema-like parameter metadata for agent providers

## Safety boundary

Tools execute in application code. The model only requests a named tool and supplies arguments.

Built-in tools intentionally avoid arbitrary shell execution, arbitrary code execution, unrestricted filesystem access, and network access.

Each tool validates its input and applies a bounded input size where appropriate.

## Usage

```ts
import { calculatorTool, jsonTool } from "@woho/tools";

const tools = [calculatorTool(), jsonTool()];
```

## Next

Add opt-in HTTP and filesystem tools behind explicit permission policies, plus stronger argument validation and runtime tests.
