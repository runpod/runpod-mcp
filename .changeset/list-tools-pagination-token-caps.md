---
"@runpod/mcp-server": minor
---

Cap list-tool responses so they no longer overflow the agent's context window.
Every `list-*` tool (`list-pods`, `list-endpoints`, `list-templates`,
`list-network-volumes`, `list-container-registry-auths`) now accepts optional
`limit` and `cursor` parameters and returns at most `limit` items (default 20,
max 100) inside a `{ items, pagination }` envelope that reports `total`,
`returned`, `truncated`, and a `nextCursor` for fetching the next page.

The REST API does not yet support server-side pagination, so this is a
client-side cap; the `limit`/`cursor` signature is shaped to match the
cursor-based pagination the REST API will add, so the tool interface will not
change when server-side pagination lands.
