---
'@runpod/mcp-server': major
---

Remove the obsolete `@runpod/mcp-server/tools` export and its `registerTools` API; connect through MCP or embed `handleMcpRequest` from `@runpod/mcp-server/http`. The HTTP entry point no longer re-exports the legacy `registerTools` or `ToolContext`.

Preserve caller abort signals through the shared fetch wrapper, including the five-second queued-job diagnosis deadline. Redact sensitive configuration assignments and submission metadata before ALP forwarding, and repeat the same redaction at the Convex storage boundary.
