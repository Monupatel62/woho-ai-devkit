# Changelog

## 0.8.19

- Completed a cross-package runtime hardening audit across provider, agents, tools, and memory.
- Bounded OpenAI-compatible streaming error responses using the provider response limit.
- Fixed source newline artifacts in provider and agent runtime code.
- Hardened JSON memory write queues so one failed persistence operation does not permanently poison later writes.
- Corrected allowed-host normalization for trailing dots and expanded regression coverage.
- Bumped `@woho/provider-openai` to 0.2.7, `@woho/agents` to 0.3.13, `@woho/tools` to 0.4.10, and `@woho/memory` to 0.6.3.

## 0.8.18

- Hardened MCP client initialization against close/initialize races.
- Validated MCP client tool/prompt names and request method inputs.
- Updated MCP client default version metadata to 0.6.12.
- Added runtime coverage for client-side name normalization.
- Bumped `@woho/mcp` to 0.6.13.

## 0.8.17

- Hardened MCP stdio framing with byte-bounded streaming stdout parsing instead of unbounded line buffering.
- Added stdio write-error propagation, JSON-RPC response validation, and cleanup-safe request timers.
- Added runtime coverage for malformed JSON-RPC responses and oversized unterminated stdio frames.
- Bumped `@woho/mcp` to 0.6.12.

## 0.8.16

- Hardened JSON memory persistence with pre-write file-size enforcement.
- Added safe unique temporary filenames and cleanup on failed writes.
- Added secure file creation mode and malformed runtime input validation.
- Added runtime coverage for oversized persistent messages and invalid input.
- Bumped `@woho/memory` to 0.6.2.

## 0.8.15

- Hardened HTTP and search tools with streaming response-size enforcement.
- Fixed filesystem policy normalization so Unix path casing is preserved.
- Fixed Tavily search provider response-limit configuration.
- Added runtime coverage for oversized search responses and filesystem policy casing.
- Bumped `@woho/tools` to 0.4.9.

## 0.8.14

- Completed cross-package public API consistency audit for core, provider, agents and MCP.
- Bounded OpenAI-compatible HTTP error bodies by the configured response limit.
- Enforced normalized agent and MCP tool names plus required MCP client metadata.
- Fixed provider runtime-test ordering and expanded integration hardening coverage.
- Bumped `@woho/provider-openai` to 0.2.6, `@woho/agents` to 0.3.12 and `@woho/mcp` to 0.6.11.

## 0.8.13

- Hardened core chat timeout/cancellation for providers that do not honor `AbortSignal`.
- Added runtime coverage for non-cooperative provider timeout behavior.
- Bumped `@woho/core` to 0.2.9.

## 0.8.12

- Hardened OpenAI-compatible chat response handling with bounded streaming body reads.
- Malformed provider JSON responses now return standardized `NetworkError` failures.
- Added runtime coverage for body limits without `content-length` and malformed JSON.
- Bumped `@woho/provider-openai` to 0.2.5.

## 0.8.11

- Hardened memory message validation for roles and timestamps.
- Added persistent JSON memory file-size limits and persisted-record validation.
- Added runtime coverage for invalid memory records and file limits.
- Bumped `@woho/memory` to 0.6.1.

## 0.8.10

- Added configurable agent tool execution timeouts.
- Hardened MCP client lifecycle with closed-state checks and concurrent initialization deduplication.
- Added runtime tests for agent tool timeout and MCP client closure.
- Bumped `@woho/agents` to 0.3.11 and `@woho/mcp` to 0.6.10.

## 0.8.9

- Audited workspace package metadata and fixed missing runtime package declarations.
- Added Node type dependency metadata for the MCP package.
- Aligned the search tool JSON schema with its positive-integer runtime limit.
- Bumped `@woho/agents` to 0.3.10, `@woho/tools` to 0.4.8, and `@woho/mcp` to 0.6.9.

## 0.8.8

- Hardened HTTP/file tool boundaries against credential-bearing URLs and oversized file reads.
- Normalized allowed host policies consistently.
- Added search-provider response-size limits and strict timeout validation.
- Added runtime coverage for the new security boundaries.
- Bumped `@woho/tools` to 0.4.7.

## 0.8.7

- Hardened the OpenAI-compatible provider with HTTPS base URL validation (localhost allowed for development).
- Added configurable provider response-size limits for chat and streaming responses.
- Added OpenAI stream reader cleanup on completion, cancellation, and response-size failure.
- Added runtime coverage for provider URL and response-size security checks.
- Bumped `@woho/provider-openai` to 0.2.4.

## 0.8.6

- Hardened persistent JSON memory with message validation and safe per-process temporary files.
- Added validation for persistent-memory query timestamps and session IDs.
- Added runtime coverage for invalid persisted messages.
- Bumped `@woho/memory` to 0.6.0.

## 0.8.5

- Hardened agent tool-call parsing: malformed JSON arguments now fail as structured tool errors instead of being passed through as strings.
- Added basic runtime validation for required and unknown tool parameters.
- Duplicate tool names are now detected after trimming whitespace.
- Added runtime coverage for malformed tool arguments.
- Bumped `@woho/agents` to 0.3.9.

## 0.8.4

- Hardened AI cancellation so already-aborted requests stop before provider execution.
- Ensured streaming iterators receive cleanup on timeout and cancellation.
- Added runtime coverage for pre-aborted requests and stream cleanup.
- Bumped `@woho/core` to 0.2.8.

## 0.8.3

- Hardened MCP stdio transport with direct request timeouts, stderr backpressure protection, write-error handling, and malformed JSON rejection.
- Added runtime coverage for MCP stdio request success and timeout behavior.
- Bumped `@woho/mcp` to 0.6.8 and aligned default client version metadata.

## 0.8.2

- Hardened search/tool policies with strict integer limits and directory validation.
- Added MCP allowed-method input validation.

## 0.8.1

- Refreshed README for the current SDK surface and development workflow.
- OpenAI-compatible SSE parsing now fails explicitly on malformed frames instead of silently dropping them.

## 0.8.0

- Added runtime testing for the OpenAI-compatible provider package.
- Added MCP timeout, oversized-response, and non-serializable-response coverage.
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
- Hardened tool policy validation and file path containment.
- Expanded tools security runtime coverage.

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
