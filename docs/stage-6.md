# Stage 6 — MCP Integration

Stage 6 adds Model Context Protocol (MCP) primitives and integration points.

## Included
- `@woho/mcp` package.
- MCP server tool registration, discovery, and execution.
- MCP client initialization and JSON-RPC request abstraction.
- MCP resources and prompts.
- Node stdio transport for external MCP server processes.
- Request cancellation and transport cleanup.
- Client method allowlisting and response-size limits.
- `@woho/agents` bridge via `createMCPAgentTools`.

## Security model
The MCP client does not automatically discover or execute arbitrary processes. An application explicitly supplies a transport.
- Stdio execution uses `shell: false`.
- Command and arguments are application-supplied.
- Request and response sizes are bounded.
- Requests can be cancelled.
- Child processes are cleaned up on close.
- MCP methods can be allowlisted.
- MCP tools exposed to agents remain application-controlled.
