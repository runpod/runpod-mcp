---
'@runpod/mcp-server': patch
---

Accept Cursor's OAuth callbacks on the hosted server (`cursor://anysphere.cursor-mcp/oauth/callback` and the `https://www.cursor.com/agents/...` and `/bot/...` web callbacks), so Cursor cloud agents and bot integrations can sign in with Runpod. `/register` now answers `invalid_redirect_uri` when none of a client's callbacks can be used, and both errors point to the API-key fallback. The install wizard and stdio `search-docs` now default to `https://mcp.runpod.io/` instead of the legacy `https://mcp.getrunpod.io/`.
