# Aether AI Integration Plan (Documentation Only)

**Status:** Proposal only. This document does not change DevKit source code, package behavior, release version, or the main branch.

## Why this document exists

Aether AI is a separate product ecosystem planned across 33 Aether repositories. WoHo AI DevKit remains its own existing project and may be consumed as a package dependency where APIs and license terms are compatible. Do not merge Aether product responsibilities into the DevKit repository by default.

## Inspected DevKit facts

The repository README describes these packages:

- `@woho/core` — provider-independent AI client, retries, timeouts, cancellation, streaming, validation, errors, and observability.
- `@woho/provider-openai` — OpenAI-compatible HTTP/SSE provider.
- `@woho/agents` — agent runtime, registries, plans, retries, execution history, approval hooks, tool events, context limits, memory, and MCP bridging.
- `@woho/tools` — calculator, JSON, text, HTTP, file, search, secure workspace, and constrained Git tools with explicit policies.
- `@woho/memory` — conversation storage, ranked/semantic search, session isolation, and summarization.
- `@woho/mcp` — MCP server/client primitives, resources, prompts, security controls, and stdio transport.

Inspected root `package.json` reports version **0.8.37**, `Apache-2.0`, package manager pnpm 10.17.0, and Node.js engine `>=20`. Confirm package-level versions/exports and published package licenses before consuming any release.

## Proposed ownership split

- Aether API: product users, conversations, authorization, run submission/status, usage, and product endpoints.
- Aether gateway/providers: model routing and provider adapters; may use compatible DevKit provider abstractions after contract tests.
- Aether agents: product-level run orchestration may wrap DevKit agent primitives; avoid duplicating the same runtime if the existing API satisfies requirements.
- Aether tools/MCP/memory: reuse DevKit packages where behavior, security, license, and version compatibility pass review; add Aether-specific policy adapters rather than forking without reason.
- Aether UI, billing, enterprise, files, knowledge, RAG, admin, deployment, and docs: remain Aether product responsibilities unless a future ADR explicitly assigns otherwise.

## Required integration spike before code

1. Pin the exact published package versions and inspect their export maps/types.
2. Write a compatibility matrix: API surface, streaming, cancellation, retries, errors, tool permissions, memory isolation, MCP transports, Node runtime, and package license.
3. Build a small isolated test fixture outside production code using mock providers/tools.
4. Verify no duplicated retry layer, conflicting cancellation semantics, or unbounded tool execution.
5. Check transitive licenses and security advisories; record the result in Aether's license register.
6. Record an ADR in Aether before choosing direct dependency, adapter, or replacement.

## Explicit non-goals

- Do not rewrite DevKit to match Aether's architecture.
- Do not bump the DevKit version or publish a package as part of this plan.
- Do not change the DevKit main branch or release pipeline.
- Do not assume the package README guarantees every capability is exported from the current published release; verify actual package manifests and tests.

## Cross-project references

- [Aether AI master repository catalog](https://github.com/Monupatel62/aether-ai-platform/blob/main/docs/REPOSITORY_CATALOG.md)
- [Aether AI master architecture](https://github.com/Monupatel62/aether-ai-platform/blob/main/docs/MASTER_ARCHITECTURE.md)
- [Aether AI decision log](https://github.com/Monupatel62/aether-ai-platform/blob/main/docs/DECISION_LOG.md)
- [DevKit source repository](https://github.com/Monupatel62/woho-ai-devkit)

## Work log

- 2026-10-22: Added this proposal on branch `docs/aether-ai-integration-plan` only. No source code, release metadata, or main-branch files were changed.
