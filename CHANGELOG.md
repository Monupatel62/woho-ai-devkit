# Changelog

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
