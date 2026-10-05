# Stage 4 — Reusable Tools

Stage 4 now includes reusable tools, formal policy enforcement, runtime tests, and a provider-neutral search interface.

## Built-ins
- calculator
- json
- text_length
- http_get
- file_read
- search (configured provider only)

## Search security model

The search tool does not choose or call an external vendor by itself. Applications inject a SearchProvider, so API keys, domains, quotas, logging, and provider-specific permissions remain under application control.

Queries and result counts are bounded before the provider is called. The model cannot replace the provider or expand the configured limits.

## Next
Add official search-provider adapters separately, then add stronger schema validation and optional write tools behind explicit policies.
