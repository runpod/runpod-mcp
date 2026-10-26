---
'@runpod/mcp-server': minor
---

Resync the vendored v2 OpenAPI spec with production as of 2026-10-26 and add
`list-audit-logs` for reading the account audit trail with filters and pagination.
`list-pods` no longer returns live utilization or the direct SSH mapping; use
`get-pod` to read those fields for an individual Pod.

Update run: https://github.com/runpod/runpod-mcp/actions/runs/40308747009
