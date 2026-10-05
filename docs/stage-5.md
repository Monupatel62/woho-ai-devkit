# Stage 5 — Memory

Stage 5 starts with a provider-neutral memory interface and a bounded in-memory implementation.

## Included
- `MemoryMessage`
- `MemoryQuery`
- `MemoryStore`
- `InMemoryStore`
- configurable message limit
- bounded list queries
- clear operation
- runtime tests

The store is intentionally persistence-neutral. A database/vector adapter can be added later without coupling agents to a storage vendor.
