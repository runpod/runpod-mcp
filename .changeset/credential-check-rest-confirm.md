---
'@runpod/mcp-server': patch
---

The hosted credential pre-flight no longer rejects an API key whose GraphQL access is set to None. A GraphQL rejection is now confirmed with `GET /v2/account` on the REST API the tools use, and only a REST 401 turns into an HTTP 401.
