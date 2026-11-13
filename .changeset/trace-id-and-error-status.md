---
'@runpod/mcp-server': minor
---

The hosted server now forwards an inbound `X-Trace-ID` header to REST v2, so a caller can join a Runpod API call to its own request. A malformed value is dropped and the call still runs. A tool error payload now has a numeric `status` when Runpod answered with a non-OK HTTP response, also when the body is empty or not JSON, so a client can tell a Runpod 401 or 429 from an MCP-side failure. An error the MCP raises itself (no API key, an invalid endpoint id, a request deadline, a GraphQL error on an HTTP 200) has no payload `status`.
