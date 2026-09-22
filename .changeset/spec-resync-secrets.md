---
'@runpod/mcp-server': minor
---

Resync the vendored v2 OpenAPI spec with production. Adds five account-secret
tools (`list-secrets`, `get-secret`, `create-secret`, `update-secret`,
`delete-secret`) and refreshes the schemas for pods, endpoints, templates,
registries, and clusters — most visibly the `cursor`/`limit` query parameters
and `pagination` response block the API now serves on its list endpoints.
