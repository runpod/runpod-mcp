---
"@runpod/mcp-server": minor
---

Default the REST version to **v2**. With nothing set, all control-plane
resources now use the v2 REST API (`v2-rest.runpod.io/v2`); set
`RUNPOD_REST_VERSION=v1` to pin the previous v1 behavior. `jobs`/`endpoints`
still resolve to v1 (no v2 home yet), CPU pods are still served by v1, and the
`auto` stdio probe is unchanged. Version-sensitive tests now pin their version
explicitly so the suite is independent of the default.
