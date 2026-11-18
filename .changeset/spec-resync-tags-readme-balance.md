---
'@runpod/mcp-server': minor
'@runpod/typescript-api-sdk': minor
---

Resync the vendored v2 OpenAPI spec with production as of 2026-11-18 and regenerate the SDK schema and the tools.

New tools: `get-template-readme` and `get-public-template-readme` return a template's README as Markdown. `list-tags`, `get-tag`, `create-tag`, `update-tag`, `delete-tag`, `list-tag-resources`, `attach-tag-resource` and `detach-tag-resource` manage tags on resources. `get-balance` returns the account balance, `get-account-limits` returns the account limits, and `update-registry` replaces a container registry credential's username and password.

`create-pod`, `create-endpoint` and `update-endpoint` take the updated request schemas from production.
