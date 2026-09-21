---
'@runpod/mcp-server': minor
---

Serve MCP tool annotations. Every tool now advertises `readOnlyHint`,
`destructiveHint`, `idempotentHint`, and `openWorldHint` in `tools/list`:
generated tools derive them from the HTTP method they wrap, so they cannot
drift from the spec, and the curated overlay declares them per tool. Hosts can
auto-approve reads and gate deletions, cancels, and queue purges on a human.
