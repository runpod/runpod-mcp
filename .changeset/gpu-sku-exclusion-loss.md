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

`update-endpoint` now refuses **every** v2 update that omits `gpuPoolIds`. The refusal happens
before any API request, is marked as an MCP tool error, and explains that no fields changed.
To proceed, the caller must supply a non-empty pool list, a positive integer `gpuCount`,
and `replaceGpuSelection: true`, explicitly acknowledging replacement of the complete GPU
selection in the same PATCH as the other changes. Requiring the count prevents the
replacement from falling back to the API's default count of one. A v2 endpoint with
`-<GPU type id>` exclusions that must survive cannot be updated through this tool until the
REST facade is fixed.

This stronger gate is required because a GraphQL pre-read does not make the later REST
PATCH atomic. Even if the read shows no exclusions, a dashboard or API writer can add one
before the PATCH; the lossy facade would then erase it. There is no ETag, endpoint version
precondition, or transaction exposed to this client. A compensating GraphQL write after
the PATCH is unsafe too: `saveEndpoint` is not sparse, unconditionally resets
`workersStandby` to `workersMax`, can trigger a second release and worker restart, can
overwrite concurrent changes, and can fail after the exclusions are already gone.

Explicit non-empty `gpuPoolIds` plus `gpuCount` and `replaceGpuSelection: true` is different:
replacement is the stated intent, not an attempt to preserve hidden exclusions. The
separate acknowledgement prevents an agent from adding pools merely to satisfy a required
field without recognizing that exclusions will be lost.

`get-endpoint` gains `includeGpuIds`, which adds the real `gpuIds` string and a
`gpuIdsHasExclusions` flag, so an endpoint's true GPU selection can be read back. Before
this, the only way to see it was `set-endpoint-gpus`, which reports `gpuIds` in its reply —
i.e. you had to write to read.

Cost, stated fully:

- Every v2 update must explicitly resend `gpuPoolIds` and `gpuCount` and acknowledge
  replacement, even when changing an unrelated field. Call `get-endpoint` first if the
  current pool list or count is needed.
- No GraphQL pre-read, post-PATCH read, compensating write, second release, environment
  cross-check, or read/write race occurs on `update-endpoint`.
- Endpoints with SKU exclusions cannot receive unrelated v2 updates through this tool
  until the REST facade preserves `gpuIds` when `gpu` is omitted.
- `get-endpoint includeGpuIds` still uses authenticated GraphQL for read-only enrichment,
  but now requests only `gpuIds` rather than the full mutation snapshot. If exactly one
  of the v2 REST or authenticated GraphQL hosts is overridden, enrichment is refused
  rather than merging endpoints from known-different environments.

`set-endpoint-gpus` refuses requests it cannot express, rather than accepting them and
echoing the stored value back as though they had applied. Round 9 found one still missing,
and the reason it was missed is worth recording: this list previously claimed to be
exhaustive, and it was not. `pools` passed together with `gpuIds` was dropped by the same
`??` precedence, one parameter over from the exclusion case that did have a guard. The
completeness claim is gone; a new parameter feeding the gpuIds string needs its own guard.
Its tool description also states the unavoidable full-read/full-save concurrency risk and
the `workersStandby` reset; callers must not treat it as a sparse or atomic alternative for
unrelated endpoint updates.

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

All `set-endpoint-gpus` refusals and pre-write read failures are marked as MCP tool
errors, matching `update-endpoint`; clients no longer have to inspect otherwise-successful
content for an embedded `error` field. A write that proceeds with
`_exclusionsUnvalidated` remains a success because the warning describes validation that
was skipped, not a refused operation.

`update-endpoint` treats non-empty `gpuPoolIds` plus a positive integer `gpuCount` with
`replaceGpuSelection: true` as explicit replacement intent and sends that PATCH directly.
Omitted pools, omitted count, omitted acknowledgement, and explicitly empty lists are
refused before any API request.

`create-pod` / `update-pod` reject `volumeInGb` without `volumeMountPath` (or the
reverse). The persistent volume is one object, so a lone field was dropped and the pod
was created with no volume while the call reported success. A test had pinned that drop
as correct behaviour.

Separately, `update-endpoint` now rejects a `gpuCount` sent without `gpuPoolIds` on v2. The
v2 `gpu` object requires `pools`, so the mapper dropped `gpu` entirely and the PATCH said
nothing about GPUs: HTTP 200, count unchanged, no indication anything was ignored. Every
v2 update now requires both values, or use `set-endpoint-gpus` to change the count alone.
`set-endpoint-gpus` also keeps its
actionable "use list-endpoints" error for an unknown id, which now arrives as a rejection
rather than a null because `endpoint(id:)` throws for an id it cannot see.
