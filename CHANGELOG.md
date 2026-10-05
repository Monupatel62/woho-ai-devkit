# Changelog

## 0.8.1

- Refreshed README for the current SDK surface and development workflow.
- OpenAI-compatible SSE parsing now fails explicitly on malformed frames instead of silently dropping them.

## 0.8.0

- Enabled runtime testing for the OpenAI-compatible provider package.
- Added MCP timeout, oversized-response, and non-serializable-response coverage.

## 0.8.0

- Added runtime coverage for the OpenAI-compatible provider.
- Enabled provider typecheck/build/runtime tests in package validation.
- Corrected MCP default client version metadata to 0.6.6.

## 0.7.9

- Hardened memory validation for queries and AI summarization limits.

## 0.7.8

- Hardened agents with tool metadata validation, duplicate tool detection, and bounded serialized tool results.

## 0.7.7

- Hardened AI streaming timeouts so stalled async iterators are interrupted by the client timeout or caller cancellation.

## 0.7.5

- Hardened MCP stdio request handling and normalized MCP runtime tests.

## 0.7.5

- Hardened tool policy validation and file path containment.
- Expanded tools security runtime coverage.

## 0.7.5

- Hardened agent configuration validation.
- Added agent runtime coverage for tool execution, memory, limits, and max-step safety.
- Fixed MCP client security option typing and normalized MCP test sources.
- Fixed summarizer newline handling.
- Added session-safe deletion to memory stores and conversation clearing.

## 0.7.3

- Added runtime coverage for core request and streaming observability hooks.

## 0.7.2

- Added optional core observability hooks for request and streaming lifecycle events.
- Added request attempt, duration, error, and stream chunk telemetry callbacks without requiring a logging dependency.

## 0.7.1

- Hardened core streaming with timeout and cancellation propagation.
- Made retry backoff cancellation-aware.

## 0.7.0

- Started Stage 7 production SDK hardening.
- Added bounded AI input validation and validated core client configuration.

## 0.6.6

- Added Stage 6 MCP integration documentation and security guidance.
- Documented stdio transport and agent-tool integration.

## 0.6.5

- Added MCP client method allowlisting.
- Added MCP response-size limits and security-policy runtime coverage.

## 0.6.4

- Added MCP resource discovery and reading.
- Added MCP prompt discovery and execution.
- Added server-side resource and prompt registration with runtime coverage.

## 0.6.3

- Added `MCPStdioTransport` for connecting to external MCP server processes over stdin/stdout.
- Added bounded message sizes, abort handling, process cleanup, and JSON-RPC error propagation.

## 0.6.2

- Added `createMCPAgentTools` to expose MCP server tools as agent tools.
- Added MCP tool failure propagation through the agent tool interface.

## 0.6.1

- Added provider-neutral `MCPClient` and transport abstraction.
- Added MCP initialization, tool discovery, tool calls, timeout handling, and runtime coverage.

## 0.6.0

- Added `@woho/mcp` with provider-neutral MCP server and tool primitives.
- Added MCP tool registration, discovery, execution, and runtime tests.

## 0.5.9

- Added memory summarization runtime coverage.
- Normalized generated TypeScript sources and fixed newline artifacts.
- Hardened Stage 5.9 memory compaction implementation.

## 0.5.8

- Added pluggable AI memory summarization.
- Added automatic agent memory compaction when a configured threshold is reached.
- Added `createAISummarizer` adapter using the existing AI client.
- Bumped `@woho/agents` to 0.3.5 and `@woho/memory` to 0.5.7.

## 0.5.7

- Added bounded, provider-neutral memory summarization.
- Added session-aware summary metadata.
- Bumped `@woho/memory` to 0.5.6.

## 0.5.6

- Added agent context message and character limits.
- Enforced session filtering in memory stores.
- Improved session-safe conversation memory handling.

## 0.5.5

- Added agent `sessionId` support for isolated conversation memory.
- Agents now use the session-aware Conversation memory layer when a session is configured.
- Bumped `@woho/agents` to 0.3.3.

## 0.5.4

- Added session-aware memory queries.
- Added provider-level optional message deletion support.
- Made conversation clearing safe and session-scoped.

## 0.5.3

- Added session-scoped `Conversation` management.
- Added bounded message retrieval and simple text-memory search.
- Added conversation runtime tests.

## 0.5.2

- Added persistent JSON-file memory storage.
- Added atomic temp-file replacement and serialized writes.
- Added runtime persistence tests.

## 0.5.1

- Integrated optional `MemoryStore` into agents.
- Agents now load prior memory and persist user, assistant, and tool messages.

## 0.5.0

- Added `@woho/memory` with a bounded in-memory store.
- Added memory message/query abstractions and runtime tests.

## 0.4.5

- Added runtime tool input validation for object schemas.
- Added duplicate-safe ToolRegistry with definitions export.
- Added validation and registry tests.

## 0.4.4

- Added Brave Search and Tavily Search provider adapters.
- Added provider request timeouts and bounded result counts.
- Added adapter runtime tests with mocked fetch.

## 0.4.3

- Added provider-neutral search tool and SearchProvider abstraction.
- Added query and result-count limits.
- Added runtime search-tool policy tests.

## 0.4.2

- Added formal ToolPolicy and policy normalization.
- Added runtime security-boundary assertions for tools.
- Exported policy helpers for application-level composition.

## 0.4.1

- Added policy-gated HTTPS HTTP GET tool.
- Added policy-gated UTF-8 file read tool.
- Added timeout, redirect, response-size and path-containment protections.

## 0.4.0

- Added reusable @woho/tools package.
- Added safe calculator, JSON, and text-length tools.

## 0.3.0

- Added composable agents.
- Added provider tool-call support and multi-step tool execution.

## 0.2.0

- Added provider-independent AI request and response types.
- Added createAI runtime client.
- Added streaming and cancellation interfaces.
- Added standardized AI errors and retry handling.
- Added mock provider.
- Added OpenAI-compatible provider.
- Added basic chat example and Stage 2 documentation.

## 0.1.0

- Initial Stage 1 repository foundation.
