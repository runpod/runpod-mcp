---
'@runpod/mcp-server': patch
---

Point both MCP initialize profiles at the Runpod REST API v2 (the OpenAPI spec at
https://api.runpod.io/v2/openapi.json and the reference at
https://docs.runpod.io/api-reference-v2/overview) for operations outside their tool
lists. The default profile also tells agents with HTTP access to call the API directly
with the same API key and where clients store it. The directory profile names no
credentials.
