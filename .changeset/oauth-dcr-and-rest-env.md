---
"@runpod/mcp-server": minor
---

Complete the hosted OAuth flow for real MCP clients. Add an OAuth 2.0 Dynamic Client Registration endpoint (`POST /register`, RFC 7591) and advertise it as `registration_endpoint`, so clients like Claude can register before signing in. Make the Runpod REST and Serverless API hosts configurable via `RUNPOD_REST_API_URL` and `RUNPOD_SERVERLESS_API_URL` so a deployment authenticating with non-production keys can target the matching environment. The console handoff path is `/integrations/mcp/login`.
