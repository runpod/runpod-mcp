---
'@runpod/mcp-server': minor
'@runpod/typescript-api-sdk': minor
---

Resync the vendored v2 OpenAPI spec with production as of 2026-11-05 and regenerate the SDK schema and the tools. Adds 31 tools: organization groups, roles, invites and member updates and removal, cost centers, and endpoint cold-start, request and worker metrics. A pod's mounts now take up to 4 network volumes and 1 global volume. The `filters` query parameter on the pod, cluster, endpoint and network volume list routes is left out until the client can send JSON query parameters.
