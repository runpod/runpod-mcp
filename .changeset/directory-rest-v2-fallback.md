---
'@runpod/mcp-server': patch
---

Point both MCP initialize profiles at the Runpod REST API v2 (the OpenAPI spec at
https://api.runpod.io/v2/openapi.json and the reference at
https://docs.runpod.io/api-reference-v2/overview) for operations outside their tool
lists. The default profile permits read-only GET calls when `RUNPOD_API_KEY` is
already in the environment and the response cannot expose secret environment
values, without accessing client credential stores or making writes outside the
MCP tool approval flow. The directory profile names
no credentials and presents the reference as informational.
