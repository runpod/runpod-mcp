---
'@runpod/mcp-server': minor
---

Resync the vendored v2 OpenAPI spec with production. Adds five account-secret
tools (`list-secrets`, `get-secret`, `create-secret`, `update-secret`,
`delete-secret`) and refreshes the schemas for pods, endpoints, templates,
registries, and clusters — most visibly the `cursor`/`limit` query parameters
and `pagination` response block the API now serves on its list endpoints.

`list-endpoints` and `list-templates` now page on the server: `limit` and
`cursor` go to the API, and `pagination` returns its `nextCursor` and
`hasNextPage` plus `returned`. `list-endpoints` drops the old client-side
`total`, `offset`, and `truncated` fields, which only counted one server page.
Requires `@runpod/typescript-api-sdk` 0.2.0.
