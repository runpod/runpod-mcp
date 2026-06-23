# V2 REST API Support — Migration Plan

> **⛔ DO NOT MERGE until v2 REST is live in production.**
> This branch (`DO-NOT-MERGE-TILL-V2-LIVE/v2-rest-support`) holds the v2 migration
> work. v2 prod (`v2-rest.runpod.io`) is **not cut yet** — only dev
> (`v2-rest.runpod.dev`) is up. Nothing here ships until prod parity is confirmed.

Tracks the MCP side of the "Agents Emergency Triage" PRD (Cycle 1: REST v2 parity).

---

## 1. Status — what is verified (live, against `v2-rest.runpod.dev`)

- **Auth: unchanged.** v2 uses `Authorization: Bearer <RPA key>`, same scheme as v1.
  A valid v1 key authenticates against v2 dev (200); bad key → 401; no key → 401.
  Prod (`.io`) currently 500s on every key — **not deployed yet**, not a key issue.
- **Spec:** `https://v2-rest.runpod.dev/v2/openapi.yaml` (public). 24 operations.
- **The MCP today is 100% v1** — single hardcoded base `rest.runpod.io/v1`, v1 paths
  baked into all 40 tools. There is no v1/v2 switch.

---

## 2. Why this is not a base-URL swap

v1 and v2 are **not 1:1**. Three independent kinds of drift, plus a coverage hole:

### a. Path drift
| Resource | v1 (today) | v2 |
|---|---|---|
| Pods list/CRUD | `/pods`, `/pods/{id}` | `/v2/pods`, `/v2/pods/{id}` |
| Pod start/stop | `POST /pods/{id}/start` + `/stop` | `POST /v2/pods/{id}/action` body `{action}` |
| Templates | `/templates` | `/v2/templates` |
| Network volumes | `/networkvolumes` | `/v2/network-volumes` (**hyphen**) |
| Registries | `/containerregistryauth` | `/v2/registries` (**renamed**) |
| GPU / data-center catalog | **GraphQL** | REST `/v2/catalog/gpus`, `/v2/catalog/datacenters` |

### b. Response-shape drift (the "envelope" problem)
v1 lists return a **bare array**; v2 lists return an **envelope object** (verified live):

| Endpoint | v1 | v2 |
|---|---|---|
| pods | `[ … ]` | `{ "pods": [ … ] }` |
| templates | `[ … ]` | `{ "templates": [ … ] }` |
| network volumes | `[ … ]` | `{ "networkVolumes": [ … ] }` |
| registries | `[ … ]` | `{ "registries": [ … ] }` |
| catalog gpus/cpus/datacenters | (GraphQL) | `{ "gpus" / "cpus" / "dataCenters": [ … ] }` |

**This breaks PR #32's `capListResult` on v2.** It only caps `Array.isArray(result)`;
a v2 envelope is an object → it hits the passthrough branch → returns the full,
**uncapped** list → context overflow comes back. Must unwrap before capping.

### c. Request-body drift (writes change too — not just reads)
`create-pod` is the worst:
| MCP v1 sends | v2 `CreatePodRequest` expects |
|---|---|
| `imageName` | `image` (**renamed**) |
| `gpuTypeIds: []`, `gpuCount` | `gpu: { … }` (**GpuConfig object**) |
| `dataCenterIds: []` | `dataCenter: string \| null` (**array → scalar**) |
| `computeType`, `cloudType` | `cpu`/`gpu` (exactly one), `cloud` |

Also: **CPU pod creation returns `501 Not Implemented`** in v2 (AE-2991 pending).
`create-network-volume`: `dataCenterId` → `dataCenter`. `create-registry`: same fields ✓.

### d. Coverage hole — v2 has **no serverless**
v2 REST has **zero** endpoint/job operations. The MCP's 13 serverless tools
(`*-endpoint`, `run`, `runsync`, `status`, `stream`, `cancel`, `retry`, `health`,
`purge-queue`) have **no v2 home** and must stay on v1 / `api.runpod.ai/v2`.
→ "Prefer v2 globally" is impossible. Routing must be **per-resource**.

### e. New in v2 (MCP should add)
- `restart` pod action (v2 `PodAction` = `start|stop|restart|terminate`)
- `list-cpu-types` (`/v2/catalog/cpus`)
- `get-gpu-type` by id (`/v2/catalog/gpus/{id}`)

---

## 3. Architecture — per-resource backend adapter

Today each tool hardcodes its v1 path and assumes v1 shapes. The fix is a thin
`_shared/` adapter that owns the "where + how" per resource, so tools become
version-agnostic.

```
src/tools/<resource>.ts   ← tool definitions (call the adapter, don't know v1/v2)
src/_shared/backend.ts    ← resolveBackend(resource): path, base, request map, normalize
```

**Tool (after):**
```ts
const pods = await backend('pods').list();   // always a clean array
return capListResult(pods, { limit, cursor });
```

**Adapter entry (the per-resource knowledge, in one place):**
```ts
pods: {
  v1: { base: REST_V1, list: '/pods',     unwrap: r => r },
  v2: { base: REST_V2, list: '/v2/pods',  unwrap: r => r.pods },
  // request mappers for create/update live here too (imageName→image, etc.)
},
jobs: { v1Only: true },   // serverless — no v2; always v1
```

Payoffs:
- **Kills the envelope bug** — `unwrap` normalizes v1 array and v2 `{pods:[…]}` to
  the same array before `capListResult` ever runs.
- **Migration = one line per resource**, flipped independently as each is validated.
- It's the natural home for the PRD's `src/tools/<resource>.ts + _shared/` split.

---

## 4. Version selection — "validate, then prefer v2"

- Env override: `RUNPOD_REST_VERSION = v1 | v2 | auto` (default `v1`).
- `auto`: probe a cheap v2 GET (`/v2/catalog/gpus`) **once at startup**, cache the
  verdict for the process. 200 → route control-plane resources to v2; else v1.
- **Never dual-call writes.** "Try v2, fall back to v1" is safe only for idempotent
  GETs. On create/delete/action a fallback retry would double-execute (e.g. create
  two pods). Writes use the probed backend deterministically — no retry-on-other.
- Serverless (`jobs`) ignores the flag — always v1.

---

## 5. Phasing

1. **Refactor, no behavior change (mergeable to main early).** Introduce the
   adapter + `normalize`/`unwrap`, route every resource through it, still pinned to
   v1. Fixes the latent envelope assumption now. Per-resource source split lands here.
2. **Add v2 mappings per resource** (path + request body + unwrap), validated against
   `v2-rest.runpod.dev`, behind `RUNPOD_REST_VERSION`. Default stays `v1`.
3. **Add new v2 tools:** `restart` action, `list-cpu-types`, `get-gpu-type`.
4. **Flip default to `auto`/`v2`** for control-plane resources — only after v2 **prod**
   is live and the dual-backend test suite is green. **This is the merge gate for this
   branch.**
5. Serverless stays v1 indefinitely (until v2 adds endpoints/jobs).
6. (PRD cycle 3) GraphQL catalog tools deprecated once v2 REST catalog is the default.

---

## 6. Testing / drift gate

- Extend the suite to run **against both backends** (`v1` and `v2` dev) — this *is*
  the "validate before preferring v2" mechanism and the CI drift gate the PRD wants.
- Assert: every v2 spec operation maps to a registered tool; live list responses
  unwrap to arrays and are capped; create/update bodies are accepted by live v2;
  `501` (CPU pods) surfaces as a clean tool error, not a crash.

---

## 7. Open questions

- v2 prod (`v2-rest.runpod.io`) cutover date — gates this branch's merge.
- CPU pod creation (501 / AE-2991) — does MCP expose it and surface "not yet
  supported", or hide the CPU path until v2 implements it?
- Catalog: keep GraphQL tools as v1 fallback during transition, or cut straight to
  v2 REST catalog once available?
- Endpoint detail filters: v2 `/v2/pods` GET declares **no query params** and ignores
  `limit` live — v1's pod filters (`computeType`, `gpuTypeId`, …) have no v2
  equivalent yet. Drop them on v2, or keep client-side?
