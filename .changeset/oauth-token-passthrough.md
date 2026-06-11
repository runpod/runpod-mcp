---
"@runpod/mcp-server": minor
---

Simplify hosted HTTP auth to pure token passthrough. The server now forwards the caller's Bearer token directly to the Runpod API and holds no credential of its own — there is no shared server-side key and no token translation. When `MCP_OAUTH_ENABLED=true`, unauthenticated requests return a `WWW-Authenticate` challenge so OAuth-capable clients start the "Sign in with Runpod" flow. Removes the `RUNPOD_HTTP_SHARED_API_KEY` environment variable and the `jose` dependency.
