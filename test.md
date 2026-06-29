# Runpod MCP — v2 testing guide

How to test the v2 REST migration — the 4-PR stack **#44 → #45 → #46 → #47**.

## Quick start

**What you need**

- Node.js 18+ and `pnpm`.
- This repo on branch `v2/group-4-source-split` with deps installed.
- For the offline suite: **nothing else** (no key, no network).
- For the live walkthrough: a Runpod **dev-account** API key + an MCP-capable agent (Claude Code, Cursor, Claude Desktop, …).

> ✅ **v2 prod is now live.** `v2-rest.runpod.io/v2` is cut over and authenticates
> with a **prod** key (allowlist-gated — an off-allowlist account 401s/403s).
> `v2-rest.runpod.dev/v2` also still works with a **dev** key. Use whichever env's
> key you have; the commands below show dev — swap the host + key for prod.
>
> The full suite (A–I, all CRUD) was run end-to-end against **prod v2** and passed,
> with every resource torn down — see [Results](#results-fill-in--this-is-the-pr-validation-record).

**Get the code**

```bash
git clone https://github.com/runpod/runpod-mcp.git && cd runpod-mcp
git checkout v2/group-4-source-split   # the stack tip; main has none of this
pnpm install
```

**Run the offline suite (start here — no key, no cost)**

```bash
pnpm test       # ~248 tests (live-shape checks skip without a key)
```

**Start the server for the live walkthrough (dev, v2)**

The launcher ships in the repo at `scripts/serve-http.local.ts` — so the launch
command below works out of the box. It just boots the real MCP HTTP handler from
`src/http.ts` on a local port — it holds no key; your key rides in per-request as
the Bearer token. For reference, it's this:

```ts
// scripts/serve-http.local.ts
// LOCAL DEV ONLY — boots the MCP server over HTTP so an agent can connect at
// http://localhost:<PORT>/. The caller's Runpod API key is passed as the request
// Bearer token (this process holds no credential). v1/v2 is controlled by this
// process's RUNPOD_REST_VERSION / RUNPOD_REST_V2_API_URL env (read once at startup).
import { createServer } from 'node:http';
import { handleMcpRequest } from '../src/http.js';

const PORT = Number(process.env.PORT ?? 3399);

const server = createServer((req, res) => {
  handleMcpRequest(req, res, { serverVersion: 'local-dev' }).catch((err) => {
    console.error('mcp handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
});

server.listen(PORT, () => {
  console.error(
    `MCP HTTP server listening on http://localhost:${PORT}/  ` +
      `(RUNPOD_REST_VERSION=${process.env.RUNPOD_REST_VERSION ?? 'v2(default)'}, ` +
      `v2 base=${process.env.RUNPOD_REST_V2_API_URL ?? 'prod default'})`
  );
});
```

Then launch it (the env vars below select dev + v2; `RUNPOD_REST_API_URL` points
the v1 base at dev too, for the CPU-pod fallback):

```bash
RUNPOD_REST_VERSION=v2 \
RUNPOD_REST_V2_API_URL=https://v2-rest.runpod.dev/v2 \
RUNPOD_REST_API_URL=https://rest.runpod.dev/v1 \
PORT=3399 \
npx tsx scripts/serve-http.local.ts        # → http://localhost:3399/
```

> Port 3399 is arbitrary — if it's taken, set `PORT=<free port>` and use that in the agent config below.

Then point your agent at `http://localhost:3399/` with header
`Authorization: Bearer rpa_YOUR_DEV_KEY` and paste the [agent prompt](#b-drive-the-test-with-an-agent-copy-paste-prompt). Sanity-check curls and agent-config snippets are in [§2a](#a-launch-the-server-locally).

---

There are two ways to test, smallest blast radius first:

1. **[Automated suite](#1-automated-suite-fast-no-key-no-cost)** — `pnpm test`. No API key, no network, no cost. Run this first; it's the CI gate and covers the whole tool surface offline (incl. the spec-parity drift gate). **Start here.**
2. **[Live walkthrough](#2-live-walkthrough-real-dev-account)** — drive the real tools against a **dev** account with an agent, confirming in the console. Use this to validate the PRs end-to-end before sign-off.

---

## 1. Automated suite (fast, no key, no cost)

This is what CI runs. Hermetic — no network, no API key.

```bash
pnpm type-check     # tsc, no errors
pnpm lint           # eslint, clean
pnpm test           # ~248 tests; the 8 live-shape checks are skipped without a key
pnpm build          # tsup bundle succeeds
```

`pnpm test` covers:

- **Outbound-request goldens** — pins the exact URL / method / body each of the 50 tools puts on the wire, for **both** v1 and v2. A behavior regression fails here.
- **Adapter / mappers / http / pagination** units — version resolution, v1→v2 body mapping (incl. endpoint inline config), SSE log-frame parsing, the list cap envelope.
- **Tool registration snapshot** — the full 50-tool surface is frozen; a dropped registrar fails.
- **Spec-parity drift gate** (`tests/spec-parity.test.ts`) — walks every operation in the vendored v2 OpenAPI spec (`tests/fixtures/v2-openapi.yaml`) and fails if a v2 endpoint has **no** MCP tool covering it. This is how we know the tool surface matches the API. To refresh the spec when v2 changes:

  ```bash
  pnpm tsx scripts/fetch-v2-spec.ts   # re-vendor tests/fixtures/v2-openapi.yaml
  pnpm test                           # any newly-uncovered endpoint now fails the gate
  ```

### Optional: live API smoke tests (need a dev key)

```bash
# create → get → delete against a dev account, FREE resources only
# (templates + registry auths), with fail-closed teardown:
RUNPOD_API_KEY=rpa_YOUR_DEV_KEY \
RUNPOD_REST_VERSION=v2 \
RUNPOD_REST_V2_API_URL=https://v2-rest.runpod.dev/v2 \
pnpm smoke:crud

# the spec-parity test's optional live-shape check (GETs the read endpoints,
# asserts the response envelopes our list tools unwrap):
MCP_LIVE_V2_KEY=rpa_YOUR_DEV_KEY MCP_LIVE_V2_BASE=https://v2-rest.runpod.dev/v2 pnpm test
```

If all of section 1 is green, the code is sound. Section 2 proves it against the real platform.

---

## 1b. Both transports (stdio + HTTP)

The server speaks two transports, and they take the API key two different ways — validate the one(s) you'll actually ship. (The §2 live walkthrough below drives **HTTP**; this covers the **stdio** path too.)

| Transport | Key source | How you "launch" it |
|---|---|---|
| **HTTP** (hosted, or local `serve-http.local.ts`) | per-request `Authorization: Bearer` header | **you** run a server process, the agent connects to its URL → see [Quick start](#quick-start) / [§2a](#a-launch-the-server-locally) |
| **stdio** (local, what `npx @runpod/mcp-server` uses) | `RUNPOD_API_KEY` **env** on the spawned process | **the agent** launches the server for you — there's no separate "start the server" step; you just register it (below) |

> Key difference to keep straight: for **HTTP** you start a long-running server yourself (the `serve-http.local.ts` launch in Quick start) and point the agent at `http://localhost:3399/`. For **stdio** you don't start anything — you give the client a `command` (`node dist/stdio.mjs`) + `env`, and it spawns/kills the process per session.

### Run the suite through stdio

```bash
pnpm build     # stdio runs the built dist/stdio.mjs
```

Register a stdio server with the dev env in your client config (Claude Code shown), then connect and drive it with the **same** [agent prompt (§2b)](#b-drive-the-test-with-an-agent-copy-paste-prompt) over the **same** [suite (§2c)](#c-the-test-suite-steps--manual-checks):

```bash
claude mcp add runpod-v2-stdio \
  -e RUNPOD_API_KEY=rpa_YOUR_DEV_KEY \
  -e RUNPOD_REST_VERSION=v2 \
  -e RUNPOD_REST_V2_API_URL=https://v2-rest.runpod.dev/v2 \
  -e RUNPOD_REST_API_URL=https://rest.runpod.dev/v1 \
  -- node "$(pwd)/dist/stdio.mjs"
```

Generic clients use the same `command`/`args`/`env` in their `mcpServers` block:

```json
{
  "mcpServers": {
    "runpod-v2-stdio": {
      "command": "node",
      "args": ["/abs/path/to/runpod-mcp/dist/stdio.mjs"],
      "env": {
        "RUNPOD_API_KEY": "rpa_YOUR_DEV_KEY",
        "RUNPOD_REST_VERSION": "v2",
        "RUNPOD_REST_V2_API_URL": "https://v2-rest.runpod.dev/v2",
        "RUNPOD_REST_API_URL": "https://rest.runpod.dev/v1"
      }
    }
  }
}
```

### Quick wiring checks (no agent)

```bash
# stdio refuses to start without a key (proves the env-key requirement)
env -u RUNPOD_API_KEY node dist/stdio.mjs </dev/null
#   → "RUNPOD_API_KEY environment variable is required", exit 1

# built-in transport smoke: MCP handshake + tools/list + a couple read calls.
# Both honor the dev-v2 env (smoke:stdio forwards RUNPOD_REST* to the child).
MCP_SERVER_URL=http://localhost:3399 RUNPOD_API_KEY=rpa_YOUR_DEV_KEY pnpm smoke:http

RUNPOD_API_KEY=rpa_YOUR_DEV_KEY \
RUNPOD_REST_VERSION=v2 \
RUNPOD_REST_V2_API_URL=https://v2-rest.runpod.dev/v2 \
pnpm build && pnpm smoke:stdio        # build first — smoke:stdio runs dist/stdio.mjs
```

> Both smoke scripts need a **dev key** for the two authenticated read calls
> (`list-gpu-types`, `list-pods`); the handshake + `tools/list` work with any key.
> (Verified: stdio handshake + `tools/list` return all **50** tools over stdio with
> the dev-v2 env, and the forwarded `RUNPOD_REST_V2_API_URL` is honored by the
> spawned server — same surface and routing as HTTP.)
>
> (Surface is **50** tools. The v2-parity pass migrated `create-endpoint`/
> `update-endpoint` to the v2 inline-config model and added two more tools —
> `stream-pod-logs` + `list-endpoint-releases` — but those two are **registered-
> disabled** (commented out) because their API ops are live on dev only and 422 on
> prod. Their code + offline tests remain; re-enable when prod ships the ops.)

---

## 2. Live walkthrough (real dev account)

A guided, human-in-the-loop pass: you launch the server locally pointed at the **dev** API, an agent drives the tools one step at a time, and **you** confirm in the Runpod console that things really spin up, update, and tear down. The filled results table at the bottom is the PR validation evidence.

> ⚠️ This hits a **real dev account**. Some steps create billable resources (pods,
> network volumes). The agent is instructed to **pause and ask before anything that
> costs money**, and every created resource is named `mcptest-*` and deleted at the end.

### Prereqs

- A Runpod **dev-account** API key → used as `rpa_YOUR_DEV_KEY` below.
- The dev REST URL: `https://v2-rest.runpod.dev/v2`.
- The repo on `v2/group-4-source-split` with deps installed (see top).
- An MCP-capable agent (Claude Code, Claude Desktop, Cursor, …).

**Key / environment matrix** (which key works where):

| Key | Authenticates against | Use for |
|-----|----------------------|---------|
| dev-account key | dev v2 (`v2-rest.runpod.dev/v2`) | **this walkthrough** — set as the Bearer |
| prod-account key | v1 prod (`rest.runpod.io/v1`) | v1 CRUD parity (section F) — mutates a **real prod account**, be careful |

Use the **dev** key for the dev host. v2 **prod** (`v2-rest.runpod.io/v2`) is now cut over — a **prod** key works there (allowlist-gated). To run this walkthrough against prod, swap `RUNPOD_REST_V2_API_URL` to the `.io` host and use a prod key.

### a) Launch the server locally

The server runs in **HTTP** mode so an agent can connect to a URL. The caller's API key is sent as the Bearer token; v2 + the dev host are set on the server process.

**1. Make sure the local HTTP launcher exists.** It's an uncommitted dev helper — create `scripts/serve-http.local.ts` from the [Quick start](#quick-start) snippet if it's missing.

**2. Start it (v2, dev host):**

```bash
# from the repo root
RUNPOD_REST_VERSION=v2 \
RUNPOD_REST_V2_API_URL=https://v2-rest.runpod.dev/v2 \
RUNPOD_REST_API_URL=https://rest.runpod.dev/v1 \
PORT=3399 \
npx tsx scripts/serve-http.local.ts
```

> `RUNPOD_REST_API_URL=…/v1` points the **v1 base at dev** too. Without it the v1
> base defaults to **prod**, so the CPU-pod fallback (G3) would route to v1-prod and
> 401 with a dev key. Setting it lets G3 succeed against dev v1.

Sanity checks (in another terminal) — these just prove the server is up; the
handshake makes **no** Runpod API call, so any non-empty Bearer (even `rpa_dummy`)
returns 200. You only need a real dev key for the actual tool calls in §2c.

```bash
# no auth → 401 (expected)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3399/ \
  -H 'Accept: application/json, text/event-stream' -d '{}'

# handshake → 200 + serverInfo
curl -s http://localhost:3399/ \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer rpa_YOUR_DEV_KEY' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"0"}}}'
```

**3. Connect your agent.**

Claude Code:

```bash
claude mcp add --transport http runpod-v2 http://localhost:3399/ \
  --header "Authorization: Bearer rpa_YOUR_DEV_KEY"
```

Generic (Cursor/Desktop-style):

```json
{
  "mcpServers": {
    "runpod-v2": {
      "url": "http://localhost:3399/",
      "headers": { "Authorization": "Bearer rpa_YOUR_DEV_KEY" }
    }
  }
}
```

> To compare against **v1**, stop the server and relaunch without `RUNPOD_REST_VERSION`
> (or `=v1`). Same key, same agent — only the version changes.

### b) Drive the test with an agent (copy-paste prompt)

Paste this to the agent connected to `runpod-v2`. It walks the suite **one step at a time**, pausing for you to confirm in the console, and asks before anything billable.

> You are connected to the `runpod-v2` MCP server (Runpod v2 REST, dev account).
> Walk me through the validation suite in `test.md`, **one numbered row at a time**
> (A1, A2, … B1, B2, … — each *row* is a step, not each section). Before you start,
> read the **"Agent rules"** section just below this prompt and follow it throughout.
> For each row:
> 1. Tell me which tool you're about to call and with exactly what arguments.
> 2. If the row is a **create / update / delete** (or costs money), **stop and wait for
>    my explicit "go"** — one fresh "go" per mutating row; never chain two mutating
>    rows on one approval. Read-only rows you may run directly.
> 3. After the call, show me the raw result. If the row has a console check, tell me
>    exactly **what to look for and where** in the console (https://console.runpod.io).
>    If the check is "—", say "no console check — confirming via tool output" and show
>    the proving field (e.g. the returned id).
> 4. Wait for my "verified" before continuing.
> 5. Record the row as PASS / FAIL / NEEDS-ATTENTION / BLOCKED with a one-line note.
> Name every created resource `mcptest-<row>`. When a create returns an id, record it
> and reuse it for that section's get/update/delete rows; keep a running list of live
> ids. At the end, fill the results table (header + rows + sign-off), print it, and
> list anything left behind. Do not invent results — only report actual tool output.

#### Agent rules (failure, teardown, cost, IDs) — read before starting

- **Teardown is mandatory.** If you received an id for any billable resource (pod,
  network volume), you MUST run its delete row before ending — even if intermediate
  steps failed or I abort. Confirm the deletion. A leaked pod/volume keeps billing.
- **Cost approval.** Before creating a pod or volume, show me the concrete config and
  its price in your "go" prompt (for a pod: the chosen GPU type + its per-hour price
  from A1) so I approve the real cost. Default to the cheapest in-stock option.
- **Create fails →** skip that section's dependent get/update/delete rows, mark them
  BLOCKED, and move to the next section (no id means nothing to act on).
- **Delete returns 404 / not-found →** that's a **PASS**: deletes are idempotent
  (re-deleting a gone resource is a no-op).
- **Delete tool errors otherwise →** tell me to delete `<resource> <id>` manually in
  the console at the listed location, and mark it NEEDS-ATTENTION / leak.
- **Pod not RUNNING →** poll `get-pod` ~every 15s for up to ~3 minutes. If it never
  reaches RUNNING (e.g. no capacity), mark NEEDS-ATTENTION and **still run E6 delete**
  so nothing leaks.
- **Negative cases (G*):** a clean "v2 only" / 501 notice **IS the PASS** condition;
  a raw crash or stack trace is the FAIL.
- **Switching v1 ↔ v2 (sections F, G1, G2)** is a **server-process** change, not a tool
  arg. Pause and tell me to stop the server and relaunch it without `RUNPOD_REST_VERSION`
  (= v1), then reconnect — you cannot do this yourself.

### c) The test suite (steps + manual checks)

Tip: a name prefix of `mcptest-` makes leaks obvious. Free resources first, billable last.

#### A — Catalog (read-only, safe, no teardown)

> Catalog lists are **paginated** like the other list tools — the result is a
> `{ items, pagination }` envelope (default 20 items). Read `items`; if
> `pagination.truncated` is true, pass `cursor: pagination.nextCursor` for the next page.

| # | Tool | Args | Expect | Manual check |
|---|------|------|--------|--------------|
| A1 | `list-gpu-types` | `minMemoryGb: 24` | list of GPU types (v2 fields) | results look sane |
| A2 | `list-data-centers` | — | list of DCs with regions | pick a `dataCenterId` whose `networkVolumeTypes` is non-empty **and** in stock — use it for D1; don't hardcode a DC (they go out of capacity) |
| A3 | `list-cpu-types` | — | CPU flavors (v2-only) | non-empty on v2 |
| A4 | `get-gpu-type` | an id from A1 | one GPU type | matches A1 |
| A5 | `get-cpu-type` | an id from A3 | one CPU flavor (v2-only) | matches A3 |
| A6 | `get-data-center` | an id from A2 | one data center (v2-only) | matches A2 |

#### B — Templates (free; full CRUD)
| # | Tool | Args | Expect | Manual check |
|---|------|------|--------|--------------|
| B1 | `create-template` | `name: mcptest-tpl`, `imageName: python:3.11-slim`, `containerDiskInGb: 10`, `isServerless: false` | returns an `id` | — |
| B2 | `get-template` | `templateId` from B1 | round-trips id + image | — |
| B3 | `list-templates` | — | B1 present | template shows in console → Templates |
| B4 | `update-template` | new `name: mcptest-tpl-2` | reflects new name | — |
| B5 | `delete-template` | `templateId` | success | gone from console |
| B6 | `list-templates` | — | B1 **absent** | confirm no `mcptest-*` remain |

#### C — Container registry auth (free; CRUD)
| # | Tool | Args | Expect | Manual check |
|---|------|------|--------|--------------|
| C1 | `create-container-registry-auth` | `name: mcptest-reg`, `username: x`, `password: y` | returns `id` | appears in console → Settings → Container Registry |
| C2 | `get-container-registry-auth` | id | metadata (no secret) | — |
| C3 | `delete-container-registry-auth` | id | success | gone from console |

#### H — Tags (free; v2-only; CRUD + attach/detach)
| # | Tool | Args | Expect | Manual check |
|---|------|------|--------|--------------|
| H1 | `create-tag` | `key: project`, `value: mcptest` | returns `id` | — |
| H2 | `get-tag` | `tagId` from H1, `includeResources: true` | round-trips key/value | — |
| H3 | `list-tags` | — | H1 present (`{items,pagination}` envelope) | — |
| H4 | `attach-tag` | `tagId` from H1, `resourceType: NETWORK_VOLUME`, `resourceId:` a live volume (D1) — **or skip if D was skipped** | success / idempotent | tag shows on the resource in console |
| H5 | `detach-tag` | same as H4 | success / idempotent | tag removed from the resource |
| H6 | `update-tag` | `tagId`, `value: mcptest-2` | reflects new value | — |
| H7 | `delete-tag` | `tagId` | success | gone |

#### I — Billing (read-only; v2-only)
| # | Tool | Args | Expect | Manual check |
|---|------|------|--------|--------------|
| I1 | `get-billing` | — (scope defaults to `all`) | `{ metadata, items, pagination }`; records capped | totals look plausible vs console → Billing |
| I2 | `get-billing` | `scope: pods`, `lastN: 7` | last 7 day-buckets of pod spend | — |

#### D — Network volumes (⚠️ billable storage; CRUD) — ask before D1
| # | Tool | Args | Expect | Manual check / intervention |
|---|------|------|--------|------------------------------|
| D1 | `create-network-volume` | `name: mcptest-vol`, `size: 10`, `dataCenterId:` from A2 | returns `id` | volume appears in console → Storage; **billing starts** |
| D2 | `get-network-volume` | id | size + DC | — |
| D3 | `update-network-volume` | `size: 20` | grown | size updated in console |
| D4 | `delete-network-volume` | id | success | **gone** from console; billing stops |

#### E — Pods (⚠️ billable GPU/CPU; full lifecycle) — ask before E1
| # | Tool | Args | Expect | Manual check / intervention |
|---|------|------|--------|------------------------------|
| E1 | `create-pod` | `name: mcptest-pod`, `imageName: python:3.11-slim`, `gpuTypeIds: [<cheapest in-stock community GPU id from A1>]`, `gpuCount: 1`, `containerDiskInGb: 10` | returns `id` | agent shows chosen GPU + price for approval; pod appears in console → Pods; **poll get-pod until RUNNING** |
| E2 | `get-pod` | id | status transitions to running | confirm boot + logs in console |
| E3 | `stop-pod` | id | stopped | console shows stopped; **GPU billing stops**, disk persists |
| E4 | `start-pod` | id | running again | console shows running |
| E5 | `restart-pod` | id | restarts (v2 PodAction) | console shows restart |
| E6 | `delete-pod` | id | success | **gone** from console; billing fully stops |

> **Endpoint workers (`list-endpoint-workers`)** needs a live Serverless endpoint id.
> If you have one on the dev account, call it and confirm a `{ items, summary,
> pagination }` envelope. Otherwise it's covered by the offline goldens — skip here.

#### J — Serverless endpoint CRUD on v2 (inline config; full lifecycle)
On **v2**, endpoints live at `/v2/serverless` with an **inline** config (image +
`gpuPoolIds` + workers + scaling) — there is **no** `templateId`. `gpuPoolIds` are
GPU **pool** names from `list-gpu-types` (the `pool` field, e.g. `AMPERE_80`), NOT
GPU type ids. `workersMin: 0` = scale-to-zero = **free at rest**.

| # | Tool | Args | Expect | Manual check |
|---|------|------|--------|--------------|
| J1 | `create-endpoint` | `name: mcptest-ep`, `imageName: runpod/test-output:0.0.1`, `gpuPoolIds: [<a pool from A1, e.g. AMPERE_80>]`, `workersMin: 0`, `workersMax: 1`, `scalerType: QUEUE_DELAY`, `scalerValue: 4`, `idleTimeout: 5` | returns `id`; body nests `gpu.pools`/`workers`/`scaling` | appears in console → Serverless |
| J2 | `get-endpoint` | `endpointId` from J1 | round-trips image + gpu.pools | — |
| J3 | `update-endpoint` | `endpointId`, `workersMax: 2` | `workers.max` reflects 2 | — |
| J4 | `delete-endpoint` | `endpointId` | 204 success | gone from console |
| J5 | `list-endpoints` | — | J1 **absent** | no `mcptest-*` remain |

> **`create-endpoint` v2 guards:** missing `imageName` → clean 400 ("needs an
> imageName"); missing `gpuPoolIds` → clean 400 ("needs gpuPoolIds"). On **v1**
> (`RUNPOD_REST_VERSION` unset) `create-endpoint` keeps the **templateId** model and
> 400s if `templateId` is missing.

#### K — Dev-only tools, currently DISABLED (not registered)
Two tools are **implemented but their registration is commented out** because their
API ops are live on **dev only** and 422 on prod:

| Tool | Op | Why disabled |
|------|----|----|
| `stream-pod-logs` | `GET /v2/pods/{id}/logs` (SSE) | dev v2 spec (47 ops) has it; prod (45 ops) 422s "path not found" |
| `list-endpoint-releases` | `GET /v2/serverless/{id}/releases` | same — dev-only, prod 422s |

They are **not callable** today (absent from `tools/list`). Their code stays in the
tree and is offline-tested (SSE-frame parser `parsePodLogSse`; mapper goldens); to
re-enable, uncomment the `server.tool(...)` block in `src/tools/pods.ts` /
`src/tools/endpoints.ts`, re-add the SPEC_OP_TO_TOOLS mapping (remove the
ALLOWLIST_UNMAPPED_OPS entry) in `tests/spec-parity.test.ts`, and add them back to
the `tools-registration` snapshot — do this once prod ships the ops.

#### F — v1 ↔ v2 parity (relaunch server on v1, repeat a subset)
Re-run **A1, A2, B1–B6** under v1 (`RUNPOD_REST_VERSION` unset). Expect the same
behavior and shapes. Note any difference.

> **Key caveat:** v1 has only a **prod** base (`rest.runpod.io/v1`). The dev key does
> catalog reads (A1/A2 are public) but **401s on v1 writes** — so B1–B6 under v1 need
> either a **prod** key (mutates a real prod account — be careful) or `RUNPOD_REST_API_URL`
> pointed at a v1 dev endpoint. With only the dev key, limit F to the read-only A1/A2.

#### G — Negative / edge cases
| # | Check | How | Expect |
|---|-------|-----|--------|
| G1 | v2-only tool under v1 | run `list-cpu-types` with server on v1 | clean "v2 only" notice (status 501), not a crash |
| G2 | v2-only tools under v1 | `get-gpu-type`, `get-cpu-type`, `get-data-center`, `restart-pod`, `list-tags`, `get-billing` on v1 | same clean 501 notice each |
| G3 | CPU pod on v2 → routes to v1 | `create-pod` with `imageName`, **`computeType: "CPU"`**, `containerDiskInGb`, on v2 | reply flagged `_servedBy:"v1"`; with `RUNPOD_REST_API_URL=…dev/v1` set it **creates a real CPU pod** on dev v1 (`cpuFlavorId: cpu5c`, ~$0.08/hr). ⚠️ **billable → delete it** (by id against dev v1: `DELETE …dev/v1/pods/{id}`). Without the dev-v1 base it 401s on v1-prod — then G3 only proves routing. |
| G4 | ambiguous create rejected | `create-pod` with `imageName` only (no `gpuTypeIds`, no `computeType`) on v2 | clean `400` "No pod type specified…" and **no request fired** |
| G5 | contradiction rejected | `create-pod` with both `gpuTypeIds` and `computeType:"CPU"` on v2 | clean `400` "…not both", no request |

---

## Results (fill in — this is the PR validation record)

Server: version `1.3.0`  base `v2-rest.runpod.io/v2` (prod)  date `2026-06-26`  tester `justin.lin@runpod.io` (driven programmatically via the stdio MCP client)

| Step | Tool | Result (PASS/FAIL/ATTN) | Notes / console observation |
|------|------|--------------------------|------------------------------|
| A1 | list-gpu-types | PASS | items=20 (v2 fields) |
| A2 | list-data-centers | PASS | items=20 |
| A3 | list-cpu-types | PASS | items=6 (v2-only) |
| A4 | get-gpu-type | PASS | round-trips id |
| A5 | get-cpu-type | PASS | `cpu3c` (v2-only) |
| A6 | get-data-center | PASS | round-trips id |
| B1 | create-template | PASS | returned id |
| B2 | get-template | PASS | round-trips |
| B3 | list-templates | PASS | present |
| B4 | update-template | PASS | rename reflected |
| B5 | delete-template | PASS | 204 |
| B6 | list-templates (gone) | PASS | absent |
| C1 | create-registry-auth | PASS | returned id |
| C2 | get-registry-auth | PASS | no secret returned |
| C3 | delete-registry-auth | PASS | 204 |
| H1 | create-tag | PASS | returned id (v2-only) |
| H2 | get-tag | PASS | round-trips |
| H3 | list-tags | PASS | present, `{items,pagination}` |
| H4 | attach-tag | PASS | attached to live pod, 204 |
| H5 | detach-tag | PASS | detached, 204 |
| H6 | update-tag | PASS | value reflected |
| H7 | delete-tag | PASS | 204 |
| I1 | get-billing (all) | PASS | `{metadata,records,pagination}`, records=11 |
| I2 | get-billing (pods, lastN) | PASS | last-7 buckets |
| D1 | create-network-volume | PASS | created @AP-JP-1 (billable storage) |
| D2 | get-network-volume | PASS | size + DC |
| D3 | update-network-volume | PASS | grown 10→20 GB |
| D4 | delete-network-volume | PASS | 204; billing stopped |
| E1 | create-pod | PASS | RTX 3070 community @ $0.13/hr |
| E2 | get-pod (RUNNING) | PASS | reached operational (stop/restart/terminate actions); subsequent ops succeeded |
| E3 | stop-pod | PASS | |
| E4 | start-pod | PASS | |
| E5 | restart-pod | PASS | v2 PodAction |
| E6 | delete-pod | PASS | 204; billing stopped |
| list-endpoint-workers | list-endpoint-workers | PASS | against a live endpoint |
| J1 | create-endpoint (v2 inline) | PASS | prod v2; `image`+`gpu.pools:["AMPERE_80"]`+`workers`+`scaling` round-tripped; `workersMin:0` (free) |
| J2 | get-endpoint | PASS | prod v2; round-trips image + gpu.pools |
| J3 | update-endpoint | PASS | prod v2; `workers.max` 1→2 |
| J4 | delete-endpoint | PASS | prod v2; 204 |
| J5 | list-endpoints (gone) | PASS | no `mcptest-*` remain (swept) |
| K — stream-pod-logs | (disabled) | N/A | registration commented out — dev-only op, 422 on prod; parser unit-tested offline |
| K — list-endpoint-releases | (disabled) | N/A | registration commented out — dev-only op, 422 on prod; offline-tested |
| F | v1↔v2 parity | PASS | A1/A2 + template CRUD re-run on v1 prod, same shapes |
| G1 | v2-only under v1 (list-cpu-types) | PASS | clean 501 |
| G2 | v2-only under v1 (get-gpu/cpu/dc-type, restart-pod, list-tags, get-billing) | PASS | clean 501 each |
| G3 | CPU pod on v2 → v1 | PASS | `_servedBy:"v1"`, created + deleted |
| G4 | ambiguous create rejected | PASS | clean 400, no request |
| G5 | contradiction rejected | PASS | clean 400, no request |

**Leak check (run at the end):** ✅ no `mcptest-*` resources remain on v1 or v2 (templates, network-volumes, registry-auths, pods, tags all clean).

**Leak check (run at the end):** `list-templates`, `list-network-volumes`,
`list-container-registry-auths`, `list-pods`, `list-tags` → confirm **no `mcptest-*`
remain**. (The automated equivalent for free resources is `pnpm smoke:crud v1 v2`.)

**Sign-off:** (prod v2, 2026-06-26)
- #44 Adapter foundation — v1 unchanged, server boots, handshake OK: ✅ (v1 parity F + G1/G2 pass)
- #45 Routing — A–D + F + G all pass on v2: ✅
- #46 Capabilities — E5 restart, G1–G3 notices: ✅
- #47 Split + new tools — H (tags), I (billing), A5/A6 (catalog gets), G2 (new v2-only 501s): ✅

**v2 full-parity addendum** (prod v2, 2026-06-29) — close the last 3 v2 gaps:
- **Endpoint CRUD migrated to v2** (`/v2/serverless`, inline image+gpu.pools+workers+scaling; v1 templateId model preserved): J1–J5 ✅ live on prod, all `mcptest-*` torn down. **This is the part that ships now** (the op is on prod).
- **`list-endpoint-releases`** + **`stream-pod-logs`** implemented but **registration DISABLED (commented out)** — their ops (`GET /v2/serverless/{id}/releases`, `GET /v2/pods/{id}/logs`) are live on **dev only** and 422 on prod, so they're not callable until prod ships them. Code + offline tests (SSE parser, mapper goldens) remain in the tree; the two dev-only ops are in `ALLOWLIST_UNMAPPED_OPS` so the parity gate stays green against the dev superset spec.
- Spec re-vendored from dev (45→47 ops); spec-parity gate green. Surface stays **50** tools (the 2 dev-only tools are not registered). Suite 219→**248** tests, all green.

---

## Saving results to the PRs

Once filled, attach this as evidence:

```bash
# paste the filled results table as a comment on the relevant PR
gh pr comment 47 --body-file test.md      # or a trimmed results-only version
```

Or commit `test.md` (with results) onto the branch if you want it tracked.
