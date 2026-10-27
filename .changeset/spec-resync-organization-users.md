---
'@runpod/mcp-server': minor
'@runpod/typescript-api-sdk': minor
---

Resync the vendored v2 OpenAPI spec with production as of 2026-10-27 and regenerate the SDK schema and the tools. Adds `list-organization-users` and `get-organization-user`, documents the 413 response on list operations, and requires a non-empty mount `path`.
