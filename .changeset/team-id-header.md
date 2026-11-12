---
'@runpod/mcp-server': minor
---

The hosted server now accepts an `X-Team-Id` request header and forwards it on every REST v2 request, so a Console (Clerk JWT) caller can act for a team. A malformed value is refused with HTTP 400 instead of silently running on the user's own account. The header is never sent to GraphQL or the Serverless runtime host.
