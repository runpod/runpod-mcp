---
'@runpod/mcp-server': patch
---

Send a `User-Agent: runpod-mcp-server/<version>` header on every outbound request to the Runpod REST, Serverless, and GraphQL APIs so MCP-driven traffic can be attributed in API logs.
