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
- **GPU live stock signal partially lost.** v2 `GpuType` has **no real-time
  `stockStatus`** (the High/Medium/Low/Out signal behind today's `includeUnavailable`),
  so that filter can't be reproduced. BUT per-cloud availability **survives** as the
  `secure`/`community` booleans + `maxCount.{secure,community}` — the B5 mapper must keep
  those. Decision (open #2): accept losing only the realtime stock signal, or keep one
  GraphQL call for it.
- **DataCenter `location` (free string) → `region` (continental enum).** The current
  client-side region substring filter breaks; rewrite against the enum.

### 1.6 Coverage hole — v2 has no serverless (and endpoint-CRUD ≠ serverless base)
v2 REST has **zero** endpoint/job operations. Two different v1 bases are involved — keep
them straight or the adapter will POST to the wrong host:
- **Endpoint CRUD (5 tools)** — `list/get/create/update/delete-endpoint` — call
  `runpodRequest` on the **REST base** (`rest.runpod.io/v1/endpoints`). When v2 ships
  `/v2/endpoints` these route like pods. `endpoints` descriptor base = **REST v1**, not serverless.
- **Serverless runtime (8 tools)** — `run-endpoint`, `runsync-endpoint`, `get-job-status`,
  `stream-job`, `cancel-job`, `retry-job`, `endpoint-health`, `purge-endpoint-queue` —
  call `serverlessRequest` on `api.runpod.ai/v2`. Permanent v1; `jobs` descriptor base = serverless.

→ **Version routing must be per-resource, never global.**

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
    endpoints.ts     ← endpoint CRUD (v1-only, REST base rest.runpod.io/v1)
    jobs.ts          ← serverless runtime (v1-only, base api.runpod.ai/v2)
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
jobs:      { v1Only: true, base: SERVERLESS },  // runtime — api.runpod.ai/v2, always v1
endpoints: { v1Only: true, base: REST_V1 },     // endpoint CRUD — REST v1, NOT serverless base
```

Payoffs: envelope bug dies in `unwrap`; body drift isolated in `mapCreate`; migration
is one mapping per resource, flippable independently; it's the home PR-side "source
split" the PRD asks for.

> **Naming note:** the descriptor key `registries` is *internal*; the public MCP tools keep
> their current names (`list-container-registry-auths`, `create-container-registry-auth`,
> … `tools.ts:1479-1543`). Do **not** rename public tools — that's a breaking change. Same
> for `jobs`/`endpoints` keys vs the real `*-endpoint`/`*-job` tool names.
>
> **Canonical `Resource` type (define once in `_shared/backend.ts`):** one union
> (`'pods'|'templates'|'networkVolumes'|'registries'|'gpus'|'cpus'|'dataCenters'|'endpoints'|'jobs'`)
> used by `unwrapList`, `resolveVersion`, and `resolveBackend` alike — so the steps don't each
> invent a spelling. The v2 unwrap key happens to equal the resource name here.
>
> **Catalog caveat:** in this sketch catalog looks like any adapter resource, but its **v1
> entry is GraphQL via a separate helper** (not the unified REST client) **through Phase A**;
> it only folds into the adapter's REST path at Step B5.

---

## Part 3 — Version selection (corrected for hosted HTTP)

> ✅ **DECIDED:** version is controlled by the `RUNPOD_REST_VERSION` env var
> (`v1 | v2 | auto`), per the rules below. Hosted deployments pin it explicitly;
> `auto` (probe-and-detect) is stdio-only.

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
    HTTP, treat `auto` as v1** (or pin the deployment to `v2` explicitly). **Do NOT add a
    bearer-hash probe cache** — any module-level map keyed by token is itself cross-user
    state on a shared warm instance, the exact leak this section exists to prevent.
- ⚠️ **No new module-level mutable state.** `SESSION_ID` (`tools.ts:39`) is already a
  process-global shared across all HTTP requests on a warm instance; the version work
  must not add another (memoized probe, cache map, etc.) in the HTTP path.
- **Per-resource override (matches C3):** `resolveVersion` checks
  `RUNPOD_REST_VERSION_<RESOURCE>` (e.g. `RUNPOD_REST_VERSION_PODS=v2`) first, falling back to
  the global `RUNPOD_REST_VERSION`. This lets a staggered v2 prod (pods live, templates not)
  flip one resource at a time. `auto` rules apply per-resolution the same way.
- New env: `RUNPOD_REST_V2_API_URL` (default `https://v2-rest.runpod.io/v2`) alongside
  the existing base consts at `src/tools.ts:9-21`.

---

## Part 4 — TDD build plan (layer by layer, bottom-up)

**Method.** Every step is a strict **RED → GREEN → REFACTOR** cycle:
1. **RED** — write the test(s) named below *first*, run `pnpm test`, watch them **fail**
   (proves the test exercises the unit, not a tautology).
2. **GREEN** — write the minimum code to pass. No extra scope.
3. **REFACTOR** — clean up with tests green. Commit at the end of each step.

**Why bottom-up.** Each layer is pure and depends only on layers below it, so it's unit-
testable in isolation with **no network and no MCP SDK**. Network and the SDK are pushed
to the edges and faked via dependency injection (an injected `fetch`, a fake `server`).
Build order = dependency order: L0 helpers → L1 adapter → L2 HTTP client → L3 handlers →
L4 v2 mappings → L5 new tools → L6 flip. v2 logic is written and tested (against fixtures)
*before* prod exists; only the live smoke (L4/§6) needs the running API.

Harness is already in place: `node --import tsx --test tests/*.test.ts`. Keep units pure.

**Core vs optional (right-sizing).** The goal is: envelope bug fixed, v2 routable, v1
unchanged. **Core path:** A0, A1, A2, A3, A4, A5, A6, B1–B6, C3. **Deferrable (nice-to-have,
cut if time-boxed):** A1b (the `auto` probe — hosted pins explicitly, stdio users can set
`=v2`), C1 (new tools `restart`/`list-cpu-types`/`get-gpu-type` — additive features, not the
migration), C2 (clean 501 — UX nicety; CPU pods don't work on v2 regardless). The A5 golden
can be scoped to the **~8 high-risk tools** (5 lists + `create-pod`/`create-template` +
`stream-job`) rather than all 36 — the rest are trivial GET/fixed-POST covered by registration tests.

**🔒 Local-only rule (hard constraint).** Everything under `tests/` runs offline with no
network, no live API, no credentials. A `tests/` file must **never** import
`scripts/smoke*.ts` or `src/stdio.ts`, and never call the real `fetch` — network reaches
units only via an injected fake `fetch`. The single network-touching check is the live
smoke **script** (Step B6), which is not part of `pnpm test`. Add a setup guard that makes
`globalThis.fetch` throw inside the test process so a live call can never silently leak in.

**DI seams are a Phase-A deliverable, not today's code.** Today `fetch` is a module-level
`node-fetch` import (`tools.ts:3`) closed over inside `registerTools`, and handlers close
over the request fn — neither is injectable yet. Steps A3/A4 must *build* the seams
(`fetch` as a param; client passed into `register<Resource>(server, ctx, deps)`) as part of
GREEN, or their RED tests have nothing injectable to target. This is stated per-step below.

---

### Phase A — Refactor to a tested, v1-only adapter (MERGEABLE TO MAIN; no behavior change)

**Step A0 — Unwrap is a pure unit (the envelope bug, killed first).**
- RED: `tests/backend.test.ts` → `describe('unwrapList')`. Cases:
  `v1 bare array → same array`; `v2 {pods:[…]} → inner array`; each resource key
  (`templates`,`networkVolumes`,`registries`,`gpus`,`cpus`,`dataCenters`); `missing key → []`;
  `non-object → []`.
- GREEN: `src/_shared/backend.ts` → `export function unwrapList(resource, version, raw)`.
- REFACTOR: table-drive the resource→key map.

**Step A1 — Version resolution is a pure unit.**
- RED: `tests/backend.test.ts` → `describe('resolveVersion')`. Cases:
  `jobs → 'v1'` and `endpoints → 'v1'` *regardless of env*; control-plane follows
  `RUNPOD_REST_VERSION` (`v1`/`v2`); unset → `'v1'`; `auto` + `transport:'http'` → `'v1'`;
  `auto` + `transport:'stdio'` → calls the injected `probe()` (mock returns true → `'v2'`,
  false → `'v1'`). Pass env + ctx + probe as **arguments** (no globals) so it's pure.
- GREEN: `resolveVersion({ resource, env, ctx, probe })`.
- REFACTOR: extract the v1-only resource set to a const.

**Step A1b — The real `auto` probe's decision logic (injected `fetch`, offline).**
- RED: `tests/backend.test.ts` → `describe('probeV2')`. Inject a fake `fetch` returning a
  canned `Response`: `200/2xx → true`; `401 → false`; `fetch throws → false`; second call
  reuses the cached verdict (fetch called once per process). No real network.
- GREEN: `probeV2({ fetch, baseUrl })` with per-process memoization (stdio only — never
  wired into the HTTP path, per Part 3).
- REFACTOR: none. (Live confirmation that the probe hits a real v2 happens in Step B6, not here.)

**Step A2 — `resolveBackend` returns the right descriptor.**
- RED: `tests/backend.test.ts` → `describe('resolveBackend')`. For each resource assert the
  v1 entry's `base` + `list`/`get(id)` paths **exactly match today's strings**
  (`/pods`, `/networkvolumes`, `/containerregistryauth`, GraphQL for catalog), `unwrap`
  is wired, `mapCreate`/`mapUpdate` default to identity under v1.
- GREEN: `resolveBackend(resource, ctx)` composing A0+A1 + a static v1 descriptor table.
- REFACTOR: one descriptor object per resource.

**Step A3 — Unified HTTP client, injected `fetch`. (SCOPE: REST + Serverless only — NOT GraphQL.)**
- **CONTRACT (pin this first — it threads through A3→A4→B4→C2):** the client is **low-level**,
  signature `client(path, method?='GET', body?): Promise<unknown>` (mirrors today's
  `runpodRequest`, `tools.ts:126-130`). On `!ok` it **throws** (stream-job's loop depends on
  it, A4) — **except 501**, which it returns as `{unsupported:true,status:501}` (C2). It takes
  a per-client `errorPrefix` option so `"Runpod API Error"` / `"Runpod Serverless API Error"`
  / `"GraphQL Error:"` are preserved (decide here, not at A5).
- PREREQ (GREEN): introduce the `fetch` seam — `createHttpClient({ apiKey, fetch, tracking, errorPrefix })`
  takes `fetch` as a param (today it's a module import, `tools.ts:3`); thread from `stdio.ts`/`http.ts`.
- RED: `tests/http.test.ts`. Inject a fake `fetch`. Cases: builds `base+path`; sets
  `Authorization: Bearer <key>` + tracking headers; serializes body only for POST/PATCH;
  `!ok → throws` with the configured error prefix (**provisional contract — C2 carves out
  501 as the one non-throwing case; note that here so C2 amends rather than regresses**);
  non-JSON / 204 / empty body → `{success:true,status}`; JSON → parsed; **`application/
  problem+json` (v2's error shape) parses as JSON** — match the `+json` *suffix*, NOT the
  literal substring `application/json` (`"application/problem+json".includes("application/json")`
  is **false**, so today's check at `tools.ts:157,207` would silently swallow v2 errors).
- GREEN: `src/_shared/http.ts`. Move `trackingHeaders` to `src/_shared/tracking.ts` (add a
  case for its clientInfo-vs-UA fallback). Merge `runpodRequest` + `serverlessRequest` only
  — path fully resolved by the adapter, so the `endpointId`-split collapses. **Leave
  `graphqlRequest` a separate helper through Phase A** (it sends no `Authorization`, has its
  own `{data,errors}` envelope + `"GraphQL Error:"` prefix — merging it would change behavior).
- ⚠️ **Three error/log prefixes must not silently change in Phase A:** `"Runpod API Error"`
  (`tools.ts:152`), `"Runpod Serverless API Error"` (`:202`), `"GraphQL Error:"` (`:109`),
  plus the two `console.error` log strings (`:163`, `:213`). Either keep a per-client prefix
  option or accept the collapse **explicitly** — A5's golden must reflect the decision.
- REFACTOR: delete the two merged helpers from `tools.ts`; re-point imports.

**Step A4 — Handlers go through the adapter (integration, faked server + client).**
- PREREQ (GREEN): introduce the client seam — `register<Resource>(server, ctx, deps)` where
  `deps.client` is injectable (built from `ctx` in production, faked in tests).
- RED: `tests/handlers.test.ts`. Fake `McpServer` (extend the capture harness to store
  handlers) + an injected client returning fixtures. Cases:
  - `list-pods` on a **v1 array fixture** → unwrap → cap to limit, envelope shape correct;
  - `list-pods` on a **v2 envelope fixture** `{pods:[…51]}` → unwrap → cap to 20, correct
    `nextCursor`/`truncated` (the composed cursor×unwrap path);
  - **empty envelope** `{pods:[]}` → `[]` → empty page, not raw passthrough;
  - `create-pod` calls client with `POST` + the (v1-identity) body **byte-identical** to
    today's passthrough (`tools.ts:549` forwards `params` verbatim);
  - **`stream-job`** (the one stateful tool, `tools.ts:1003-1082`): a `while` poll loop that
    depends on the client **throwing** on `!ok` to count `consecutiveErrors` (max 5) and on
    terminal status to break. Assert against the merged client: terminal-status break,
    consecutive-error abort, timeout. ⚠️ The C2 501 special-case must NOT defang this loop's
    error counter — 501 mid-stream still needs to surface as an error, not `{unsupported}`.
- GREEN: split `tools.ts` → `src/tools/{pods,templates,network-volumes,registries,
  catalog,endpoints,jobs}.ts`; each handler calls `resolveBackend(...)` + the client +
  `capListResult`. `registerTools` just calls each `register<Resource>(server, ctx, deps)`.
- REFACTOR: collapse the duplicated `JSON.stringify` response wrapper into one helper.

**Step A5 — Existing tests stay green + outbound-request golden (regression lock, not a RED cycle).**
- add to `tests/pagination.test.ts` a case asserting `capListResult` stays **array-only**
  (its contract didn't change; unwrap is the adapter's job). Confirm
  `tools-registration.test.ts` (`>=30`, `CORE_TOOLS`, list params) still passes.
- **Offline OUTBOUND-REQUEST golden (NOT output-only, NOT live).** The refactor's whole risk
  is on the *wire*, so diffing tool *output* against a fixture client proves nothing about
  headers/query-strings/body. Instead: drive all 36 tools with a fake client that **records
  `{url, method, headers, body}`** for every call, capture that on `main`, and diff after the
  refactor. This is what actually catches header reorder/casing, query-param encoding
  (`list-pods` manual `URLSearchParams` + boolean `.toString()`, `tools.ts:439-462`), and the
  `create-pod` body passthrough. Store under `tests/fixtures/golden/`. No network, no key.
- **End of Phase A → PR to main.**

**Step A6 — Wire `pnpm test` into CI (the gate must exist).**
- Today `.github/workflows/ci.yml` runs only `type-check`, `lint`, `build` — **not the
  tests**. Add a `Test` step running `pnpm test` before Build (across the existing Node
  matrix). Without this, "tests gate the merge" is fiction. Offline suite only; no secrets.

---

### Phase B — Add v2 mappings per resource (behind the flag, default still v1)

Each resource is one independent RED→GREEN cycle; order doesn't matter, do pods first
(highest risk). All mappers are **pure** → fixture-tested before touching the network.

**Step B1 — Pod request mappers (pure, the riskiest unit).**
- RED: `tests/mappers.test.ts` → `mapPodCreateToV2`. Cases (from Part 1.4):
  `imageName→image`, `containerDiskInGb→disk`, `volumeInGb/volumeMountPath →
  mounts.persistent.{size,path}`, `gpuTypeIds[0]→gpu.id` + `gpuCount→gpu.count`,
  `cloudType→cloud`, `dataCenterIds[0]→dataCenter`; unknown keys dropped; **never emits
  both `gpu` and `cpu`** (v2 enforces exactly one); round-trip a full v1 body → expected v2
  JSON. Assert against a **committed fixture** `tests/fixtures/v2-create-pod.json` (offline).
  ⚠️ Spec-volatility (Part 7: `dataCenter` scalar may revert to `dataCenterIds[]`, `cloud`
  may drop `ALL`): when the live spec moves, **update the fixture in a dedicated commit** —
  tests never reach the network to discover this.
- GREEN: `mapPodCreateToV2` + `mapPodUpdateToV2` in `src/_shared/mappers.ts`; wire as the
  pod descriptor's `mapCreate`/`mapUpdate` v2 entry.
- REFACTOR: share the `ContainerConfig` flatten between create + update + templates.

**Step B2 — v2 descriptors + unwrap keys per resource.**
- RED: extend `resolveBackend` tests: under `RUNPOD_REST_VERSION=v2`, each resource
  resolves the v2 base + path (`/v2/pods`, `/v2/network-volumes`, `/v2/registries`,
  `/v2/catalog/*`) and the correct `unwrap` key; jobs/endpoints still resolve v1.
- GREEN: fill the `v2` half of each descriptor.
- REFACTOR: dedupe path-building.
- ⚠️ **Decide the lost pod/template filters here** (Part 1.5 names them but no step owned
  them): `computeType`, `gpuTypeId`, `dataCenterId`, `name` have no v2 query param. Either
  (a) drop them from the tool schema under v2, or (b) keep them and filter client-side after
  `unwrap`, before `capListResult`. Expansion flags (`includeMachine`/`includeTemplate`/
  `includeNetworkVolume`, open #3) can't be faked client-side — confirm whether v2 expands
  by default, else drop. Pin the choice with a test (pure filter fn or schema assertion). (same RED→GREEN as B1, committed fixtures).
- Template: `imageName→image`, **`isServerless→serverless`** (rename), `category`/`public`
  added, drop `readme`. ⚠️ **`dockerEntrypoint[]` + `dockerStartCmd[]` → single `args`
  string is lossy** — pin the chosen join semantics (order + separator) in the test, or
  surface a warning; don't leave it implicit.
- Volume: `dataCenterId→dataCenter`. Registry: unchanged.

**Step B4 — Pod actions: start/stop → `podAction` under v2.**
- RED: handler test — under v2, `stop-pod` calls `POST /v2/pods/{id}/action` body
  `{action:'stop'}`; under v1, `POST /pods/{id}/stop`. Same for start.
- GREEN: branch in the pods descriptor.

**Step B5 — Catalog GraphQL→REST under v2 (+ filter regression).**
- RED: mapper tests for GPU/datacenter field renames (`displayName→name`,
  `location`→`region` enum), and that the v2 mapper **keeps `secure`/`community` +
  `maxCount`** (per-cloud availability survives; only realtime `stockStatus` is lost).
  Pure filter-fn tests: `filterDataCentersByRegion` (v1 substring on `location` vs v2 enum
  match) and `filterGpuTypes`; handler resolves GraphQL under v1, REST under v2.
- GREEN: add v2 REST catalog descriptors; keep GraphQL as the v1 entry.
- ⚠️ **Decide capping:** today `list-gpu-types`/`list-data-centers` bypass `capListResult`
  (raw `JSON.stringify`, `tools.ts:342-349`). Routing them through the adapter will newly
  cap them — desirable (catalogs are large), but make it a **deliberate** choice with a
  test, not an accidental output change. Resolve open #2 (availability) before C3.

**Step B6 — Live CRUD smoke against the dev account (with mandatory cleanup).**
`scripts/smoke.ts` looped over `RUNPOD_REST_VERSION ∈ {v1,v2}` against `v2-rest.runpod.dev`
(§6). Live create/update/delete is OK on the dev account — but every created resource
**must be torn down**, even on assertion failure. Not in CI; not part of `pnpm test`.

---

### Phase C — New tools, error handling, then flip

**Step C1 — New tools (additive, test-first).**
- RED: `tools-registration.test.ts` asserts `restart`-capable pod action,
  `list-cpu-types`, `get-gpu-type` register; the `>=30` + no-dupes checks still hold.
- GREEN: add them via the adapter.

**Step C2 — CPU-pod 501 → clean error (pin the contract — fake must match real).**
- ⚠️ Today the client **throws** on any `!ok` (`tools.ts:150`), so 501 would throw, not
  "return". Pick one and make the fake match: have `createHttpClient` **special-case 501
  before the generic throw**, returning `{ unsupported: true, status: 501 }`; the
  create-pod handler maps that to the clean message.
- RED: `tests/handlers.test.ts` — injected client returns the `{unsupported:true,status:501}`
  shape; assert the tool result is **non-error content** (`isError` falsy) containing
  "CPU pods not yet supported on v2 REST", and does **not** throw.
- GREEN: the 501 special-case in the client + the handler mapping.

**Step C3 — Flip the default (per-resource, not one global switch).**
- ⚠️ **Resolve the routing-vs-control contradiction.** Part 1.6 says routing is per-resource,
  but a single `RUNPOD_REST_VERSION=v2` flips *all* control-plane resources at once. v2 prod
  ships staggered (Part 7 milestones) — if pods is live but templates isn't, a global flip
  routes templates to a 404/501. Add a **per-resource override**: `resolveVersion` consults
  `RUNPOD_REST_VERSION_<RESOURCE>` (e.g. `RUNPOD_REST_VERSION_PODS=v2`) falling back to the
  global. RED: `resolveVersion` test — per-resource override beats global; unset resource
  inherits global. Flip each resource only when *its* v2 prod endpoint returns 200 + its
  live smoke is green.
- **Gate:** v2 PROD returns 200 *for that resource* + dual-backend smoke green. Merge gate for the branch.
- **Rollback.** Hosted HTTP rolls back by env (flip the var). The **published stdio binary
  bakes the default into the release** — rollback there is a **patch release reverting the
  default**, NOT an env tweak users can't set. So: soak the v2 default on hosted before it
  ships in an stdio release.
- **Pre-Phase-B owners:** assign open #2 (GPU availability) an owner and decide it before
  Phase B (it's a human decision currently blocking the C3 gate). Serverless stays v1.

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
- **Unit/integration tests are defined test-first in Part 4** (the RED step of each
  cycle): `tests/backend.test.ts`, `http.test.ts`, `mappers.test.ts`, `handlers.test.ts`,
  plus the existing `pagination.test.ts` / `tools-registration.test.ts`. All offline,
  pure or DI-faked, run by `pnpm test` (`node --import tsx --test tests/*.test.ts`).
- ⚠️ **`pnpm test` is not in CI today** — `ci.yml` runs only type-check/lint/build.
  **Step A6 adds the test step** so the suite actually gates merges. Until then it's a
  local gate only.
- **Offline guard (Part 4 rule):** `tests/` never imports `scripts/smoke*.ts` or
  `src/stdio.ts` and never calls real `fetch`; a test-setup stub makes `globalThis.fetch`
  throw so no live call can leak into the offline suite.
- **Live CRUD drift gate (dev account, the only *live* test — separate from the offline
  suite and from C3's prod-200 gate):** generalize
  `scripts/smoke.ts` (already transport-abstracted) to loop `RUNPOD_REST_VERSION ∈ {v1,v2}`
  with `RUNPOD_REST_V2_API_URL` → dev. It does **real CRUD** against the dev account:
  create → get/list (assert unwrap + cap) → update → delete, plus CPU-pod 501 = clean error.
  One key drives both passes (same auth scheme). Add a `smoke:v2` script. **This dual-run IS
  the "validate before preferring v2" mechanism** and gates the Phase C flip (Step C3).
- **Cleanup is part of the test (mandatory):**
  - **Name-first, not ID-first.** Generate a unique `mcp-smoke-<uuid>` name *before* the
    create call and track it; teardown deletes **by name (list→match→delete)**, so a resource
    is reclaimable even if the create response never parsed or the ID was never captured
    (closes the create/ID-capture race and the partial-501 half-create).
  - Every create paired with a delete in a **`try/finally`** so teardown runs on assertion
    throw. `finally` also **re-runs the prefix sweep** for *this* run (not just at startup).
  - **Poll-to-terminal then delete, with bounded retry/backoff.** A provisioning pod or an
    attached volume returns 409 on immediate delete. Delete-pod → poll until gone → then
    delete its volume. Retry 429/5xx with backoff. Do **not** silently swallow delete
    failures — a swallowed failure + the leftover check below would contradict.
  - **Post-verify is fail-closed.** At end, list `mcp-smoke-*`; if any remain **or the list
    call itself errors** → exit non-zero (unknown = fail, never "empty = pass").
  - **Out-of-band janitor (optional — see Part 8).** A standalone `scripts/sweep.ts`
    (list+delete all `mcp-smoke-*`) as a **manual** cleanup for the rare SIGKILL'd run that
    skips `finally`. A standing daily cron is overkill for a dev-account test — the next
    run's pre-sweep self-heals. Add the cron only if this becomes an always-on gate.
  - Order teardown by dependency (pods before the volumes they mount).

---

## Part 7 — Known gaps & upstream (Linear) status

Cross-checked against the producer project **[ROCK] API_2026 Q2: Public REST API v2**
(`rock-api-2026-q2-public-rest-api-v2-aacf7ba84474`, lead Brody Kellish, Core APIs).
**We are not filing tickets there** — this is a read-only cross-reference of where each
gap already lives. The producer side is `rphttp2` (the v2 service); the MCP is a consumer.

### Decided
- **Version control:** `RUNPOD_REST_VERSION = v1 | v2 | auto` env var (Part 3). Hosted
  pins explicitly; `auto`-probe is stdio-only. Closed.

### Consumer gaps (MCP-side, ours to handle in this branch)
| Gap | Handling | Where |
|---|---|---|
| Envelope bug (`capListResult` no-ops on `{pods:[…]}`) | `unwrap` in the adapter before capping | Part 2, Phase A |
| Request-body remap (`imageName→image`, `gpuTypeIds[]→gpu.id`, ContainerConfig flatten) | `mapCreate`/`mapUpdate` per resource | Part 1.4, Phase B |
| Lost client filters (`computeType`, `name`, …) | filter client-side after unwrap, before cap | Part 1.5 |
| CPU-pod `501` surfaced raw | catch → clean tool error | Phase C |

### Producer gaps — already tracked upstream (do NOT re-file)
| Our gap | Upstream Linear ticket(s) | Note |
|---|---|---|
| CPU pods stubbed (501 / AE-2991) | "Support CPU-only pod creation on /v2/pods (deployCpuPod)"; "Add per-DC CPU pricing/availability" | v2 will implement; until then MCP shows "not yet supported" |
| GPU availability / `stockStatus` absent | "Add per-DC GPU/CPU availability to /v2/catalog"; "Add additional catalog filters for availability" | regression is temporary — availability is coming to /v2/catalog |
| List filters + pagination missing | Epic "Cursor pagination + filtering across list endpoints (R5)" + R5.1–R5.4 | confirms PRD forward-compat: v2 *will* add cursor/filter; client-side filter is the bridge |
| Serverless absent from v2 REST | "Basic serverless endpoint CRUD"; "/v2/serverless/{id}/jobs"; "/workers" subroutes (`/serverless` milestone, ~15%) | serverless IS coming to v2 (`/v2/serverless/*`, `/v2/endpoints`) — our 13 v1-only tools get a v2 home later |

### ⚠️ Spec is mid-flight — do NOT hardcode against today's snapshot
The frozen `openapi.yaml` we mapped has fields the producer team is actively changing.
Build the Phase-B `mapCreate`/`mapUpdate` against the **live** spec at implementation
time, not this analysis:
- **`dataCenter` scalar → `dataCenterIds` array** — epic "Migrate dataCenterId from CSV
  string to String[]" (PR 1–6). My array→scalar mapping for create-pod **reverses**.
- **`cloud` enum drops `ALL`** — "Remove ALL from pod-create cloud enum; default SECURE".
- **Template `category`** — "Make category optional … then deprecate & remove". Won't
  stay required; don't force it.
- **Network-volume size bounds** — min 1→10, max 4000→4096 ("size constraints wrong in spec").
- **CreatePodRequest** — "missing SSH key / startScript support" (fields will be added).

### MCP-relevant upstream items (consumer coordination, not ours to file)
- Milestone **"MCP Usability Issues"** (0%, no target) — natural home if the producer
  team wants the MCP-facing gaps tracked; flag to Brody rather than filing ourselves.
- "Add migration assistant (Claude skill) for moving from v1 to v2".
- "[placeholder] migrate CLI from V1 to V2" (runpodctl parity — PRD cycle 2).
- Milestone "Deprecation notice for rphttp (REST v1)" targets **2026-08-03**; "Public beta
  launch" **2026-07-20** — i.e. v1 won't vanish at v2 launch, so the dual-backend adapter
  is the right shape through the overlap.

### Still open (need a human decision)
1. v2 **prod** cutover date — gates this branch's merge. *(you said don't worry about it)*
2. GPU availability: accept the temporary regression on v2 (recommended — availability
   ticket exists), or keep one GraphQL call for `stockStatus` during the gap?
3. Expansion flags (`includeMachine`/`includeTemplate`/`includeNetworkVolume`) have no v2
   query equivalent and can't be faked client-side — drop on v2, or confirm v2 expands by
   default?

---

## Part 8 — Operational safeguards (right-sized)

The branch lives weeks→months until v2 prod and the spec moves under us. But this is a
single-process npm wrapper hand-driven against a **dev** account, not a production service —
so keep these light. Keepers are cheap and earn their weight; the rest are deferred.

**Keep (cheap, real value):**
- **Branch cadence.** Phase A merges to `main` immediately (behavior-neutral, independently
  useful). Phase B/C live on this branch — **rebase on `main` weekly**.
- **Version observability.** Add `X-Runpod-Rest-Version: <v1|v2>` to the outbound tracking
  headers (one line in `_shared/tracking.ts`) so logs can attribute the version used once
  routing is per-resource.
- **Manual spec re-check.** A line in the Phase B checklist: *re-pull the live spec before
  writing each mapper* (catches the `dataCenter` scalar↔array reversal, `cloud` ALL removal,
  `category` optionality). Optionally a hand-run `pnpm spec:check` diff script.

**Optional / defer (only if the branch outlives expectations):**
- A **scheduled spec-drift CI job** (auto-diff dev openapi, open issues) — overkill while a
  human is actively driving; the checklist line above covers it.
- An **out-of-band cron janitor** — `try/finally` name-first teardown + fail-closed
  post-verify (Part 6) already cover ~all cases; a SIGKILL'd run leaks a few `mcp-smoke-*`
  dev pods costing pennies, self-healed by the next run's pre-sweep. Keep `scripts/sweep.ts`
  as a **manual** cleanup if wanted; skip the standing daily cron.
