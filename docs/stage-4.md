# Stage 4 — Reusable Tools

Stage 4 now has reusable tools plus a formal policy helper.

## Built-ins
- calculator
- json
- text_length
- http_get
- file_read

## Policy
Use `createToolPolicy()` to create a normalized policy. Network and filesystem tools receive the policy at construction time and enforce it at execution time.

The model cannot grant itself access. Empty allowlists deny access.

## Runtime verification
The package includes runtime assertions for deterministic tools and security boundaries. The workspace `test` command currently uses TypeScript checks as its baseline; the runtime test file is included as the next CI execution target.

## Next
Wire runtime tests into CI, add stronger argument validation, and add opt-in search tooling with explicit provider boundaries.
