# Stage 4 — Reusable Tools

Stage 4 provides reusable tools with explicit security boundaries.

## Tools

- calculator: bounded arithmetic only
- json: bounded JSON parsing
- text_length: deterministic text utility
- http_get: HTTPS-only, explicit host allowlist, redirect disabled, response-size limit and timeout
- file_read: explicit directory allowlist, realpath containment check and file-size limit

## Security model

The model cannot expand permissions. The application creates tools with a policy and the tool enforces it at runtime.

Example:

```ts
import { fileReadTool, httpGetTool } from "@woho/tools";

const tools = [
  httpGetTool({ allowedHosts: ["api.example.com"] }),
  fileReadTool({ allowedDirectories: ["/srv/woho/data"] }),
];
```

No arbitrary shell execution is included. Filesystem writes and unrestricted HTTP are intentionally not enabled by default.

## Next

Add runtime tests and a formal permission/policy helper so applications can compose multiple tools safely.
