---
"@runpod/mcp-server": minor
---

Add a `GET /authorize` route to the hosted HTTP server so it can act as the authorization server for Claude's MCP connector ("Sign in with Runpod"). The OAuth discovery metadata now advertises this server as the authorization server, and `/authorize` builds the real Clerk authorize URL, registers it with the Runpod backend via the guest `createClaudeOAuthRequest` GraphQL mutation, then redirects the browser to the Runpod console handoff page. The GraphQL endpoint and console base URL are configurable via `RUNPOD_GRAPHQL_URL` and `CONSOLE_BASE_URL`.
