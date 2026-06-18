---
"@runpod/mcp-server": minor
---

Add HTTP transport for hosted MCP server deployments. The package now exports three entrypoints: `@runpod/mcp-server` (stdio, unchanged), `@runpod/mcp-server/http` (streamable HTTP with per-request auth), and `@runpod/mcp-server/tools` (shared tool definitions). This enables deploying the MCP server on Vercel or any HTTP-capable host where each request carries its own RunPod API key via the Authorization header. Existing stdio users are unaffected.
