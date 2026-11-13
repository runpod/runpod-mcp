---
'@runpod/mcp-server': minor
---

The hosted server now forwards an inbound `X-Trace-ID` header to REST v2, so a caller can join a Runpod API call to its own request. A malformed value is dropped and the call still runs. REST error results now always include the upstream HTTP `status` in their payload, also when the upstream body is empty or not JSON, so a client can tell a Runpod 401 or 429 from an MCP-side failure.
