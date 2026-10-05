# Stage 4 — Reusable Tools

Stage 4 now includes reusable tools, formal policy enforcement, runtime tests, and a provider-neutral search interface plus official Brave and Tavily adapters.

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

## Validation and registry
- Built-in object schemas are validated at runtime for required fields, types, and unknown parameters.
- `ToolRegistry` provides duplicate-safe registration, lookup, listing, and provider-ready definitions.

## Provider adapters
- `createBraveSearchProvider({ apiKey })` uses the Brave Web Search API.
- `createTavilySearchProvider({ apiKey })` uses the Tavily Search API.
- API keys are application-supplied and never model-controlled.
- Both adapters enforce bounded result counts and request timeouts.
