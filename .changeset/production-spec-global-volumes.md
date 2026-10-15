---
'@runpod/typescript-api-sdk': minor
---

Resync the vendored production spec and regenerate the types. Adds the global-volume operations (`/v2/global-volumes` list, create, get, update, delete) and `GET /v2/organization`, `global` mounts on pods, `mounts` on endpoints, and the `pagination` block on the cluster and network-volume list responses. All additive upstream, so existing calls keep their current types. `listClusters` and `listNetworkVolumes` now return one page (default `limit` 1000) instead of every resource; follow `pagination.nextCursor` until `hasNextPage` is false.
