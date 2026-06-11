---
"@runpod/mcp-server": minor
---

Add a "Sign in with Runpod" OAuth flow to the hosted HTTP server so it can act as the authorization server for Claude's MCP connector. When `MCP_OAUTH_ENABLED=true`, the server advertises itself in the OAuth discovery metadata and exposes `GET /authorize` and `POST /token`. The flow reuses the Runpod flash auth backend: `/authorize` creates a guest `createFlashAuthRequest` and hands off to the Runpod console for approval, and `/token` polls `flashAuthRequestStatus` and returns the minted Runpod API key as the access token, which the server then forwards to the Runpod API. The backend endpoint and console base URL are configurable via `RUNPOD_GRAPHQL_URL` and `CONSOLE_BASE_URL`.
