---
'@runpod/mcp-server': minor
---

Preserve GPU SKU exclusions across `update-endpoint` (#63).

The v2 REST endpoint model cannot represent a SKU exclusion: `EndpointGpuConfig` is
`{pools, count}`, with nowhere to keep the `-<GPU type id>` entries that pin an individual
card. That value exists only in the GraphQL `gpuIds` string, so a v2 `PATCH` could drop
exclusions even when the update never mentioned GPUs — silently, since nothing in the REST
reply reveals it.

Confirmed live on 2026-07-29: an endpoint with `gpuIds` of
`AMPERE_16,-NVIDIA RTX A4500,-NVIDIA RTX 2000 Ada Generation`, patched with only
`{"image": "..."}`, came back as plain `AMPERE_16`. Both exclusions were gone; every other
field survived.

`update-endpoint` now reads the authoritative `gpuIds` **before** an unrelated v2 PATCH.
If the endpoint has SKU exclusions, the update is refused before mutation with a 409 that
names the protected value. If the GraphQL check fails or the credential has no GraphQL
user, the update is refused with a 503 instead of guessing that there is nothing to lose.
No fields are changed in either case.

This deliberately fails closed rather than attempting a compensating GraphQL write after
the PATCH. Such a write cannot make the update atomic: `saveEndpoint` is not sparse,
unconditionally resets `workersStandby` to `workersMax`, can trigger a second release and
worker restart, and can overwrite a concurrent update between the read and restore. It can
also fail after the REST PATCH has already removed the exclusions. Refusing before the
known-destructive operation is the only safe MCP-side behavior until the v2 REST facade
preserves `gpuIds` when `gpu` is omitted.

An explicit non-empty `gpuPoolIds` bypasses the preservation guard because it is an
intentional replacement of the endpoint's GPU selection. The tool description now says
that v2 cannot carry existing `-<GPU type id>` exclusions forward in that request.

`get-endpoint` gains `includeGpuIds`, which adds the real `gpuIds` string and a
`gpuIdsHasExclusions` flag, so an endpoint's true GPU selection can be read back. Before
this, the only way to see it was `set-endpoint-gpus`, which reports `gpuIds` in its reply —
i.e. you had to write to read.

Cost, stated fully:

- One GraphQL read per v2 `update-endpoint` call that does not explicitly replace
  `gpuPoolIds`.
- No post-PATCH read, compensating write, second release, or restore race.
- During a GraphQL outage, unrelated v2 endpoint updates fail closed. Availability is
  traded for the guarantee that this tool will not silently erase SKU pins.
- Endpoints with exclusions cannot receive unrelated v2 updates through this tool until
  the REST facade is fixed; callers must use a path that preserves the complete `gpuIds`.
- The caller's API key goes to the authenticated GraphQL host for the safety check. If
  `RUNPOD_AUTHED_GRAPHQL_URL` is overridden, it must point only at a trusted host.

`set-endpoint-gpus` refuses requests it cannot express, rather than accepting them and
echoing the stored value back as though they had applied. Round 9 found one still missing,
and the reason it was missed is worth recording: this list previously claimed to be
exhaustive, and it was not. `pools` passed together with `gpuIds` was dropped by the same
`??` precedence, one parameter over from the exclusion case that did have a guard. The
completeness claim is gone; a new parameter feeding the gpuIds string needs its own guard.

Exclusions are also checked against the pools' real SKUs before anything is written. The
API validates less than it appears to: it rejects an exclusion that is itself a pool id,
and rejects excluding every SKU, but membership is an exact string compare — so a
near-miss id (`-NVIDIA RTX 4000 Ada`, where the real id ends ` Generation`) is stored
happily and excludes nothing, leaving the endpoint on the whole pool while the reply reads
as a successful pin. Mismatches are now refused with the pool's actual SKU list. The check
needs the GPU catalog, so when that cannot be read the write still proceeds and the reply
carries `_exclusionsUnvalidated` — unchecked is disclosed rather than implied.

`create-endpoint` no longer drops v1-only fields on v2. `computeType` and `gpuTypeIds` do
not exist in the v2 body, so they were silently ignored: `computeType:'CPU'` produced a
**GPU endpoint billed at GPU rates** (v2 cannot create CPU endpoints at all — the API
exposes CPU config as read-only), and `gpuTypeIds` widened an SKU pin to the entire pool.
Both now return a 400 naming `RUNPOD_REST_VERSION=v1`, matching what `update-endpoint`
already did for a lone `gpuCount`.

The refusals in full:

- `excludeGpuTypeIds` without `pools` (exclusions are built onto a pool list, so alone
  they have nowhere to go), and `excludeGpuTypeIds` alongside a raw `gpuIds` (which takes
  precedence, so they would be dropped).
- An explicitly empty `pools`, and an empty `gpuIds` string — the latter previously fell
  through to a message claiming the endpoint was a CPU one.
- A GPU selection aimed at a **CPU endpoint**. The server discards it silently:
  `computeType` is derived from `cpu*` instance ids, the GPU validator returns undefined
  for anything not GPU without reading `gpuIds` at all, and the update then writes
  `gpuIds: null`. A write happened, the pin was never stored, and the reply claimed
  success.

`update-endpoint` treats a non-empty `gpuPoolIds` as explicit replacement intent and sends
that PATCH directly. Omitted pools take the fail-closed preservation path; an explicitly
empty list is still rejected rather than silently dropped by the mapper.

`create-pod` / `update-pod` reject `volumeInGb` without `volumeMountPath` (or the
reverse). The persistent volume is one object, so a lone field was dropped and the pod
was created with no volume while the call reported success. A test had pinned that drop
as correct behaviour.

Separately, `update-endpoint` now rejects a `gpuCount` sent without `gpuPoolIds` on v2. The
v2 `gpu` object requires `pools`, so the mapper dropped `gpu` entirely and the PATCH said
nothing about GPUs: HTTP 200, count unchanged, no indication anything was ignored. Send both,
or use `set-endpoint-gpus` to change the count alone. `set-endpoint-gpus` also keeps its
actionable "use list-endpoints" error for an unknown id, which now arrives as a rejection
rather than a null because `endpoint(id:)` throws for an id it cannot see.
