---
"@runpod/mcp-server": minor
---

Add v2-only tools covering the rest of the v2 REST surface:

- **Tags** — `list-tags`, `get-tag`, `create-tag`, `update-tag`, `delete-tag`,
  and `attach-tag` / `detach-tag` to associate a tag with a pod, network volume,
  cluster, or serverless endpoint.
- **Billing** — `get-billing` returns time-bucketed spend, either aggregated or
  broken down by resource type (`scope`), windowed by `startTime`/`endTime` or
  `lastN`. The records array is capped via `limit`/`cursor`.
- **Endpoint workers** — `list-endpoint-workers` lists the workers behind a
  serverless endpoint plus an aggregate summary (capped via `limit`/`cursor`).
- **Catalog by id** — `get-cpu-type` and `get-data-center` round out the catalog
  alongside the existing `get-gpu-type`.

These resources exist only on the v2 REST API, so each returns a clean `501`
notice on v1 (set `RUNPOD_REST_VERSION=v2`).
