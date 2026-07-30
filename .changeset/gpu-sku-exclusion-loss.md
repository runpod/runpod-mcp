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

`update-endpoint` now reads `gpuIds` before patching, then re-reads the endpoint after the
patch and re-applies that `gpuIds` on top, reporting it under `_gpuIdsPreserved`. The
re-read matters: `saveEndpoint` is not sparse, so echoing the pre-patch snapshot would put
back whatever the caller had just changed. Endpoints without exclusions (the common case)
are untouched and pay no extra write, and the restore is skipped entirely when the patch
left `gpuIds` alone — so the compensation disappears on its own once the v2 facade stops
rebuilding `gpuIds` from `gpu.pools`. An explicit `gpuPoolIds` still wins — the caller is
deliberately rewriting the pool list — but the reply now names the exclusions that were
lost. If the restore itself fails, the reply says so and quotes the expected `gpuIds`
rather than reporting a clean success.

If the `gpuIds` read fails, the update still applies — a GPU safety net must not block an
unrelated change — but the reply now carries `_gpuIdsCheckSkipped` saying so. Silence there
was indistinguishable from "this endpoint has no exclusions to lose", which is issue #63
recurring behind a claim that it is fixed. It is reachable with a credential that can PATCH
over REST but cannot read the endpoint through GraphQL `myself`.

The restore echoes only the fields `saveEndpoint` writes unconditionally. Fields it writes
solely when the input carries them are deliberately omitted, because echoing a read value
back does damage: `modelReferences` reads as `[]` when empty, and `[]` means *clear all
model references*, which strips `MODEL_NAME` from the endpoint's env and rolls its workers;
a non-empty value re-validates every reference without a HuggingFace token, so a gated model
fails the write outright. `compliance` reads as `[]`, which resolves to NULL server-side and CLEARS the endpoint's compliance requirements;
`templateId` is read only on the create path, so echoing it on an update is at best a
no-op; `networkVolumeIds` creates volume rows on a legacy single-volume endpoint; and
`type` is both written and validated only when present, so echoing a future `AiApiType`
the validator rejects (`RT` is already in the enum) would fail every restore for no
benefit. `requestTTL` is now read and echoed, because it *is* written unconditionally and
is compared for the version bump — omitting it registered as a change and rolled the
workers for nothing.

`get-endpoint` gains `includeGpuIds`, which adds the real `gpuIds` string and a
`gpuIdsHasExclusions` flag, so an endpoint's true GPU selection can be read back. Before
this, the only way to see it was `set-endpoint-gpus`, which reports `gpuIds` in its reply —
i.e. you had to write to read.

Cost, stated fully:

- One GraphQL read per v2 `update-endpoint` call — including endpoints with no exclusions,
  which pay the read but no write.
- A second GraphQL read for every endpoint that carries exclusions — it happens before
  the "did anything change?" check, so it is paid whether or not anything was lost.
- One `saveEndpoint` write only for endpoints that carry exclusions AND actually lost
  them to the patch.
- The caller's API key now goes to the authenticated GraphQL host on every v2
  `update-endpoint`. If you override `RUNPOD_AUTHED_GRAPHQL_URL`, point it only at a host
  you trust with that.
- `saveEndpoint` writes `workersStandby := workersMax` unconditionally, and `workersStandby`
  is not a field of `EndpointInput` — so the restore cannot preserve a value that differs
  from `workersMax`. The echo-everything-written rule cannot cover this one.
- The restore re-validates the stored config against today's rules (account worker limits,
  the GPU pool catalogue, pool access). An endpoint whose stored config has since drifted out
  of validity fails the restore and reports `_warning` — honest, but it then sits without its
  exclusions until `set-endpoint-gpus` is run.

The `workersStandby` limitation above is now stated in the `set-endpoint-gpus` and
`update-endpoint` tool descriptions too. They previously said all other settings were
"preserved" and "only provided fields change" — which contradicted this changeset, in the
text an agent reads at call time to decide whether a call is safe.

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

`update-endpoint`'s `gpuPoolIds` warning is now established by re-reading rather than
asserted from the fact that pools were sent — so it disappears on its own if the facade
stops dropping exclusions, instead of telling callers to repair something that is fine.

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
