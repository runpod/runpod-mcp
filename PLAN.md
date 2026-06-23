# V2 REST Support — Architecture & Step Plan

> ⛔ Branch `DO-NOT-MERGE-TILL-V2-LIVE/v2-rest-support`. v2 prod (`v2-rest.runpod.io`)
> is **not cut yet**; only dev (`v2-rest.runpod.dev`) is up. This is the deep plan.
> `V2-MIGRATION-PLAN.md` is the short summary; this file is the working doc.

---

## Part 0 — Mental model (start here if confused)

**What the MCP server is.** A small Node program that exposes Runpod's API as
"tools" an AI agent can call. Not a website. Not a skill. A **translator**:

```
Claude Code ──MCP protocol──▶ runpod-mcp ──HTTPS──▶ Runpod API
 "list my pods"               list-pods tool         GET /pods
```

**Two ways it runs (same 36 tools, two doors):**
- **stdio** (`src/stdio.ts`) — runs on your laptop, key from `RUNPOD_API_KEY` env.
  One long-lived process = one user = one key. This is the published `npx` binary.
- **hosted HTTP** (`src/http.ts` + `api/index.ts`) — runs on Vercel. **Stateless:
  a fresh server is built per request**, and the **user's key arrives per request**
  as the `Authorization: Bearer` header (or is minted by the OAuth flow). One warm
  instance serves *many different users/keys* over its life. ← this fact drives the
  whole version-selection design (Part 4).

**How one tool call works today** (`src/tools.ts`, all 36 inline in `registerTools`):
1. Zod schema validates the agent's args.
2. Handler builds a path (`/pods`) + optional `URLSearchParams` or POST body.
3. Calls one of three HTTP helpers:
   - `runpodRequest(endpoint, method, body)` — REST, base `rest.runpod.io/v1` (26 tools)
   - `serverlessRequest(endpointId, path, …)` — base `api.runpod.ai/v2` (8 tools)
   - `graphqlRequest(query, …)` — base `api.runpod.io/graphql` (2 tools)
4. Wraps the JSON for the agent. List tools (5 of them) run it through
   `capListResult` first (PR #32's cap).

**The base URL + path are hardcoded to v1 in every tool.** That is the entire
"no v1/v2 split" problem.

---

## Part 1 — The gap (live-verified against `v2-rest.runpod.dev`)

24 v2 operations. The MCP has 36 tools. They do **not** line up 1:1. Four kinds of drift:

### 1.1 Auth — no change ✅
v2 = `Authorization: Bearer <RPA key>`, identical to v1. A valid v1 key returns 200 on
v2 dev; bad key → 401. OAuth (Part 5) mints a plain RPA key — no v2 risk. **Nothing to do.**

### 1.2 Path drift
| Resource | v1 (now) | v2 |
|---|---|---|
| Pods | `/pods`, `/pods/{id}` | `/v2/pods`, `/v2/pods/{id}` |
| Pod start/stop | `POST /pods/{id}/start` + `/stop` | `POST /v2/pods/{id}/action` `{action}` |
| Templates | `/templates` | `/v2/templates` |
| Network volumes | `/networkvolumes` | `/v2/network-volumes` (**hyphen**) |
| Registries | `/containerregistryauth` | `/v2/registries` (**rename**) |
| GPU / datacenter catalog | **GraphQL** | REST `/v2/catalog/gpus`, `/datacenters`, `/cpus` |

### 1.3 Response-shape drift — the "envelope" bug (confirmed live)
v1 lists return a **bare array**; v2 lists return an **object**:

| v2 endpoint | shape | unwrap key |
|---|---|---|
| `/v2/pods` | `{ pods: [...] }` | `pods` |
| `/v2/templates` | `{ templates: [...] }` | `templates` |
| `/v2/network-volumes` | `{ networkVolumes: [...] }` | `networkVolumes` |
| `/v2/registries` | `{ registries: [...] }` | `registries` |
| `/v2/catalog/{gpus,cpus,datacenters}` | `{ gpus / cpus / dataCenters: [...] }` | per-resource |

`capListResult` (`src/pagination.ts:71`) only caps `Array.isArray(result)` → a v2
envelope is an object → it hits passthrough → **returns the full uncapped list** →
context overflow returns. Must `unwrap` to the inner array before capping.

### 1.4 Request-body drift (writes change too — `create-pod` is the worst)
v2 introduces a shared `ContainerConfig` (`image`, `args`, `disk`, `ports`, `env`,
`registry`) spread into pod/template bodies. Field-by-field for `create-pod`:

| v1 sends | v2 expects | change |
|---|---|---|
| `imageName` | `image` | renamed |
| `containerDiskInGb` | `disk` | renamed |
| `volumeInGb` | `mounts.persistent.size` (min 10) | scalar → nested |
| `volumeMountPath` | `mounts.persistent.path` | scalar → nested |
| `gpuTypeIds: []` | `gpu.id` (string) | **array → scalar** |
| `gpuCount` | `gpu.count` | nested |
| `cloudType` (SECURE/COMMUNITY) | `cloud` (+`ALL`) | renamed + new value |
| `dataCenterIds: []` | `dataCenter` (string, nullable) | **array → scalar** |
| — | `args`, `registry`, `mounts.network[]` | added |
| — | `cpu` | added — **CPU pods return `501 Not Implemented`** (AE-2991) |

`create-template`: same flattening, **drops** `dockerEntrypoint`/`dockerStartCmd`
(→ single `args`) and `readme`, **adds required `category`** (CPU/NVIDIA/AMD) + `public`.
`create-network-volume`: `dataCenterId` → `dataCenter`. `create-registry`: unchanged ✓.

### 1.5 Filters & features lost in v2
- **All list/get query filters are gone.** v2 `/v2/pods` and `/v2/templates` declare
  **zero query params** (verified: `?limit=1` ignored live). v1's `computeType`,
  `gpuTypeId`, `dataCenterId`, `name`, `includeMachine`, `includeTemplate`, etc. have
  no v2 equivalent → drop, or filter client-side.
- **GPU availability (`stockStatus`/`includeUnavailable`) cannot be reproduced** from
  v2 catalog — no availability field. Either keep GraphQL for that one signal or accept
  the regression.
- **DataCenter `location` (free string) → `region` (continental enum).** The current
  client-side region substring filter breaks; rewrite against the enum.

### 1.6 Coverage hole — v2 has no serverless
v2 REST has **zero** endpoint/job operations. These 13 MCP tools have **no v2 home**
and stay on v1 / `api.runpod.ai/v2` forever (until v2 adds them):
`list/get/create/update/delete-endpoint`, `run-endpoint`, `runsync-endpoint`,
`get-job-status`, `stream-job`, `cancel-job`, `retry-job`, `endpoint-health`,
`purge-endpoint-queue`. → **Version routing must be per-resource, never global.**

### 1.7 New in v2 — tools to add
`restart` pod action · `list-cpu-types` (`/v2/catalog/cpus`) · `get-gpu-type`
(`/v2/catalog/gpus/{id}`).

---

## Part 2 — Target architecture: per-resource adapter

Today each tool hardcodes its v1 path + assumes v1 shapes. Introduce a thin layer
that owns the per-resource "where + how", so tools stop knowing about versions.

```
src/
  tools/
    pods.ts          ← pod tool definitions (call the adapter)
    templates.ts
    network-volumes.ts
    registries.ts
    catalog.ts
    endpoints.ts     ← serverless config (v1-only)
    jobs.ts          ← serverless runtime (v1-only)
  _shared/
    http.ts          ← one HTTP client (merges runpodRequest/serverlessRequest/graphql)
    backend.ts       ← resolveBackend(resource, ctx): base, path, mapRequest, unwrap
    tracking.ts      ← trackingHeaders (moved out of tools.ts)
  pagination.ts      ← capListResult (unchanged; now always fed a clean array)
  tools.ts           ← shrinks to: registerTools() imports + calls each tools/*.ts
```

**A tool, after:**
```ts
// tools/pods.ts
const pods = await backend('pods', ctx).list();   // already an array, version-agnostic
return capListResult(pods, { limit, cursor });
```

**The adapter holds the per-version knowledge in one place:**
```ts
// _shared/backend.ts
pods: {
  v1: { base: REST_V1, list: '/pods',     get: id => `/pods/${id}`,
        unwrap: r => r,           mapCreate: p => p },                 // bare array, passthrough body
  v2: { base: REST_V2, list: '/v2/pods',  get: id => `/v2/pods/${id}`,
        unwrap: r => r.pods,      mapCreate: mapPodCreateToV2 },       // envelope + body remap
},
jobs:      { v1Only: true },     // serverless runtime — always v1
endpoints: { v1Only: true },     // serverless config  — always v1
```

Payoffs: envelope bug dies in `unwrap`; body drift isolated in `mapCreate`; migration
is one mapping per resource, flippable independently; it's the home PR-side "source
split" the PRD asks for.

---

## Part 3 — Version selection (corrected for hosted HTTP)

> ⚠️ **The naive "probe v2 once at process startup and cache" is WRONG for hosted HTTP.**
> A warm Vercel instance serves many users/keys; `registerTools` runs fresh per request
> with that request's key. A process-global cached verdict would leak one user's v2
> result onto every other user on that instance — a correctness/security bug. (stdio is
> fine — one process = one key.)

Rules:
- Selection is **per-resource** (jobs/endpoints pinned v1) **and per-request** (scoped to
  `ctx.apiKey`, never a module-level singleton).
- `RUNPOD_REST_VERSION = v1 | v2 | auto`, default `v1`.
  - `v1` / `v2`: explicit, no probe — just read env (env is global config, safe to share).
  - `auto`: **stdio only** — probe once per process (one key) and cache. For **hosted
    HTTP, treat `auto` as v1** (or pin the deployment to `v2` explicitly) — do not probe
    per request in the hot path inside the 60s budget unless cached by a hash of the
    bearer with a short TTL.
- New env: `RUNPOD_REST_V2_API_URL` (default `https://v2-rest.runpod.io/v2`) alongside
  the existing base consts at `src/tools.ts:9-22`.

---

## Part 4 — Step-by-step (each step is its own PR)

**Phase A — Refactor only, still v1, MERGEABLE TO MAIN NOW (no behavior change).**
1. Extract the 3 HTTP helpers + `trackingHeaders` into `src/_shared/http.ts` +
   `tracking.ts`. Pure move, tools.ts imports them.
2. Add `src/_shared/backend.ts` with `resolveBackend(resource, ctx)` returning **only
   v1** entries (paths exactly as today, `unwrap: r => r`, `mapCreate: p => p`).
3. Route every tool through the adapter. List tools now do `unwrap` → `capListResult`.
   **This hardens the envelope assumption before v2 ever lands.**
4. Split `tools.ts` into `src/tools/<resource>.ts`; `registerTools` just calls each.
5. Tests stay green (`>=30` tools, `CORE_TOOLS`, list params). Add envelope unit cases
   to `pagination.test.ts` (feed `{pods:[…]}` → assert it caps).

**Phase B — Add v2 mappings per resource (behind flag, default still v1).**
6. For each control-plane resource (pods, templates, network-volumes, registries,
   catalog), add the `v2` adapter entry: path, `unwrap`, and `mapCreate`/`mapUpdate`
   (the ContainerConfig flattening + array→scalar for pods). Validate each live against
   `v2-rest.runpod.dev`.
7. Catalog: switch `list-gpu-types`/`list-data-centers` to REST under v2 (keep GraphQL
   as the v1 entry). Decide the availability-signal question (Part 6).
8. Map `start-pod`/`stop-pod` → `podAction` under v2; keep separate v1 paths.

**Phase C — New tools + flip.**
9. Add `restart`, `list-cpu-types`, `get-gpu-type` (additive — tests stay green).
10. Surface CPU-pod `501` as a clean tool error ("CPU pods not yet supported on v2"),
    not a crash.
11. **Flip default to `v2` for control-plane resources — only after v2 PROD is live and
    the dual-backend live suite is green. This is the merge gate for this branch.**
12. Serverless stays v1. (PRD cycle 3: deprecate GraphQL catalog tools once v2 REST is
    the default.)

---

## Part 5 — OAuth / transport notes (no action, just constraints)
- OAuth (`api/index.ts`) mints a **plain RPA key** returned as the bearer — same kind as
  a manual key, accepted by v2. No scope/audience difference. No v2 work needed.
- There is **no `MCP_OAUTH_ENABLED` flag** in code (the PRD assumes one); the hosted
  OAuth routes are always registered. Cosmetic to the v2 work.
- `__PACKAGE_VERSION__` is a tsup build-time define reachable from `stdio.ts`/`http.ts`/
  `tools.ts`. New `src/_shared/*` and `src/tools/*` imported by `tools.ts` inherit it —
  fine. `api/index.ts` reads version at runtime (separate path) — leave it alone.

---

## Part 6 — Testing / drift gate
- `pnpm test` is **offline only** today (`node --test tests/*.test.ts`).
- Unit: parametrize the fake-server test to assert the adapter resolves the right
  path/base per resource under `RUNPOD_REST_VERSION=v1` and `=v2`, and that
  jobs/endpoints resolve v1 regardless. Add envelope cases to `pagination.test.ts`.
- Live drift gate: generalize `scripts/smoke.ts` (already transport-abstracted) to loop
  `RUNPOD_REST_VERSION ∈ {v1, v2}` with `RUNPOD_REST_V2_API_URL` → dev. Assert: every
  list unwraps + caps; create/update bodies accepted live; CPU-pod 501 = clean error.
  One key drives both passes (same auth scheme). Add `smoke:v2` script. **This dual-run
  IS the "validate before preferring v2" mechanism.**

---

## Part 7 — Open questions
1. v2 **prod** cutover date — gates this branch's merge.
2. CPU pods (501/AE-2991): expose with "not yet supported", or hide CPU path until v2 implements?
3. GPU availability signal: keep GraphQL for `stockStatus`, or accept the regression on v2?
4. Lost list filters (`computeType`, `name`, …): drop on v2, or reimplement client-side
   after the (uncapped) fetch?
5. Hosted HTTP `auto` mode: pin per-deployment to v1/v2, or build per-key probe caching?
   (Recommend: pin per deployment; reserve `auto`-probe for stdio.)
