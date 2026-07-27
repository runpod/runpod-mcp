---
'@runpod/mcp-server': major
---

Resync the tool surface with the current v2 REST spec: remove the seven tag tools, add three ECR delegation tools.

**Breaking — the seven tag tools are removed.** `list-tags`, `get-tag`, `create-tag`,
`update-tag`, `delete-tag`, `attach-tag` and `detach-tag` called `/v2/tags`, which no longer
exists: `GET /v2/tags` returns `404 {"detail":"The requested path was not found."}` on both
`v2-rest.runpod.io` and the dev host, and the operations are gone from both served specs.
The tools could not succeed for any caller, so they are removed rather than left to 404.

**New — AWS ECR delegation.** `list-registry-delegations`, `create-registry-delegation` and
`delete-registry-delegation` cover `/v2/registries/delegations`. This is a second way to
pull a private image, distinct from `create-container-registry-auth`: instead of storing a
username and password, you register an ECR repository ARN and Runpod is granted scoped pull
access, with the reply carrying a `dockerRegistryUri` plus the resolved repository, tag and
region. v2-only — the tools return a clean 501 notice under `RUNPOD_REST_VERSION=v1`.

`create-template` no longer sends `category: NVIDIA` when the caller omits it. v2 made the
field optional with that same documented server-side default, so the value is left unsent
instead of being invented client-side. An explicit `category` still passes through, and the
resulting template is unchanged either way.
