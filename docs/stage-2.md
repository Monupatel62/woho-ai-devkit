# Stage 2 — AI Core

Stage 2 provides the first usable AI runtime layer.

Included:
- Provider-independent message, request and response types
- createAI client
- Streaming interface
- AbortSignal support
- Request timeout
- Retry support for retryable provider errors
- Standardized AI errors
- Mock provider for tests
- OpenAI-compatible HTTP provider
- Usage normalization
- TypeScript example

Security:
API keys are supplied at runtime and are never stored by the SDK. Do not commit credentials.

See examples/basic-chat for a minimal integration.