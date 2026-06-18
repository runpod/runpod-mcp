---
"@runpod/mcp-server": minor
---

Validate the OAuth `redirect_uri` against an allowlist. Because the authorization code redeems into a real Runpod API key, `/authorize` and `/token` now reject any `redirect_uri` that is not an allowlisted client callback, preventing an attacker from crafting an authorize link that delivers the code (and key) to a host they control. Loopback addresses (`http://localhost` / `127.0.0.1` / `::1`, any port) are always allowed per RFC 8252; the hosted client callbacks default to Claude's, and the list is extendable via `MCP_ALLOWED_REDIRECT_URIS` (comma-separated).
