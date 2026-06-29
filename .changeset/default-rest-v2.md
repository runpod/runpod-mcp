---
"@runpod/mcp-server": major
---

**Breaking:** default the REST version to **v2**, and migrate Serverless
endpoint CRUD to the v2 API.

With nothing set, all control-plane resources now use the v2 REST API
(`v2-rest.runpod.io/v2`); set `RUNPOD_REST_VERSION=v1` to pin the previous v1
behavior.

Why this is a major bump: `create-endpoint`/`update-endpoint` move from the v1
**template-based** model to the v2 **inline-config** model. On v2,
`create-endpoint` no longer accepts a `templateId` — it requires `imageName` +
`gpuPoolIds` (GPU pool names from `list-gpu-types`, e.g. `AMPERE_80`) plus
optional `workers`/`scaling`. So an existing integration that calls
`create-endpoint` with `{ templateId }` and no `RUNPOD_REST_VERSION` pin will
get a clean `400` after upgrading, with no code change on their side. To keep
the old behavior, pin `RUNPOD_REST_VERSION=v1` (templateId model preserved).

`jobs` still resolves to v1 (serverless runtime API, no v2 home). CPU pods are
still served by v1, and the `auto` stdio probe is unchanged. Version-sensitive
tests pin their version explicitly so the suite is independent of the default.

See the README "REST API version (v1 / v2)" section for the migration note.
