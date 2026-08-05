---
'@runpod/mcp-server': patch
---

Refuse the standalone GET SSE stream with 405. The HTTP server is stateless and never sends server-initiated messages, so the GET "listen" stream has nothing to carry — but the SDK accepted it anyway and held the response open with nothing to send until the platform's maxDuration killed it, at which point every connected client immediately re-opened it. On the hosted deployment that loop was ~1.1M hung requests per day (90% of all traffic), each ending in a 60-second timeout, and it dominated the serverless bill. GET now gets the spec's answer for a server without an SSE stream: 405 Method Not Allowed with an `Allow: POST, DELETE` header and a JSON-RPC error body, before any auth work — a 401 there would send OAuth clients into a pointless re-auth flow. Clients per the MCP spec treat the 405 as "no server-initiated messages offered" and continue POST-only; tool calls are unaffected.
