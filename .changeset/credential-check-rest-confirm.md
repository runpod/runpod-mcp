---
'@runpod/mcp-server': patch
---

The hosted credential pre-flight no longer rejects an API key whose GraphQL access is set to None. A GraphQL rejection is now confirmed with `GET /v2/account` on the REST API the tools use, and only a REST 401 turns into an HTTP 401. That 401 now says the key was rejected by both GraphQL and REST. A key that REST answers with 403 (its scopes leave out `account:read`) is let through and logged as `rest_forbidden`, apart from the `fail_open` label for an unreachable auth backend.
