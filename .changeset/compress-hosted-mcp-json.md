---
'@runpod/mcp-server': patch
---

Compress hosted MCP JSON responses when clients accept gzip or Brotli, while leaving streaming SSE responses untouched.
