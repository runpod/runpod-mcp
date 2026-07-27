---
'@runpod/mcp-server': major
---

Resync the tool surface with the current v2 REST spec.

**Breaking:** removes the seven tag tools (`list-tags`, `get-tag`, `create-tag`, `update-tag`,
`delete-tag`, `attach-tag`, `detach-tag`). `/v2/tags` no longer exists — it returns
`404 "The requested path was not found."` on both the production and dev hosts — so the tools
could not succeed for any caller.

**New:** three AWS ECR delegation tools (`list-registry-delegations`,
`create-registry-delegation`, `delete-registry-delegation`) for `/v2/registries/delegations`.
Unlike `create-container-registry-auth`, this stores no credentials: you register an ECR
repository ARN and Runpod is granted scoped pull access. v2-only.

**New:** `create-network-volume` gains `volumeType` (`STANDARD` | `HIGH_PERFORMANCE`). The
field was in the spec but no tool exposed it, so high-performance volumes could not be created
here. Omit it for the data center default. Its documented size range is also corrected to
10–4096 GB (was 1–4000).

**Enabled:** `list-endpoint-releases` was implemented but left unregistered because
`GET /v2/serverless/{id}/releases` used to be dev-only. It now returns 200 on production.

`create-template` no longer sends `category: NVIDIA` when the caller omits it — v2 made the
field optional with that same server-side default, so the value is no longer invented
client-side. An explicit `category` still passes through.
