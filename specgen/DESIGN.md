# Design: the spec-generated MCP server

A progressive explanation of this branch. Each level adds detail — stop
reading when you have enough.

---

## Level 0: one sentence

An AI agent sends HTTPS requests to this server; the server checks who they
are, translates "tool calls" into Runpod REST v2 API calls, and most of its
tools are not written by hand — a script produces them from the API's own
description file.

---

## Level 1: the three boxes

```
      AI agent (Claude, Cursor, ...)
        │ hosted: HTTPS + Bearer     │ local: stdio + env key
        ▼                            ▼
   ┌──────────────────────────────────────────────┐
   │ BOX 1 — THE FRONT DOORS                      │
   │ src/http.ts   (hosted, via the service)      │
   │ src/stdio.ts                 (local process) │
   │ Both mount the SAME Box 2 — one surface.     │
   └──────────────────────┬───────────────────────┘
                          ▼
   ┌──────────────────────────────────────────────┐
   │ BOX 2 — THE TOOLS           (new, runtime)   │
   │ src/specgen/                                 │
   │ 49 generated + 17 hand-written tools,        │
   │ 10 skill documents, logging, rate-limit seat │
   └──────────────────────┬───────────────────────┘
                          ▼
              api.runpod.io/v2  (Runpod REST API)
```

There is a third box that never runs in production:

```
   ┌──────────────────────────────────────────────┐
   │ BOX 3 — THE INGREDIENTS    (dev-time only)   │
   │ @runpod/typescript-api-sdk/spec/openapi.yaml │
   │                             the API's menu   │
   │ specgen/generator-config.yaml  our judgment  │
   │ specgen/generator/          the script       │
   └──────────────────────────────────────────────┘
```

Box 3 is read only when a developer runs `pnpm generate:tools` — the output
is committed to git, and the running server just imports it like normal code.

---

## Level 2: the flow of one request

The hosted flow (local stdio is the same from step 3 on, with the process
env key instead of a bearer token). Every request is independent:

```
1. AI sends:  POST /  { "method": "tools/call",
                        "name": "get-pod",
                        "arguments": { "podId": "abc" } }
              header: Authorization: Bearer <the caller's Runpod key>

2. BOX 1 (src/http.ts)
   - no token?            → 401, stop
   - dead token?          → 401 (pre-flight check), stop
   - builds a FRESH server for this request, carrying THIS caller's key
     (src/http.ts, the createSpecgenServer call)

3. BOX 2 (src/specgen/server.ts)
   - rate-limit seat: currently always admits (stub)
   - looks the tool up by name:
       hand-written tool?  → run its own handler function
       generated tool?     → go to the shared executor (dispatch.ts)

4. dispatch.ts (the one executor all 49 generated tools share)
   - the tool is DATA, not code:  { method: 'GET',
                                    path: '/v2/pods/{podId}', ... }
   - required argument missing?  → 400 naming it, stop
   - fills the URL, splits args into path/query/body
   - calls the SDK:  ctx.sdk.GET('/v2/pods/{podId}', {...})

5. the `@runpod/typescript-api-sdk` package (from runpod/js-sdk,
   bundled into the build)
   - a thin wrapper over fetch: fills the URL template, adds the
     Authorization header, retries safe requests on 429/5xx
   - sends the real HTTPS request to api.runpod.io/v2

6. the result rides back up:
   - dispatch normalizes to { ok, status, payload }
   - server.ts attaches a recovery hint on errors
     ("verify the id with the matching list- tool"),
     logs ONE line (tool, hashed caller, status, ms — never the key
     or the arguments), and returns JSON to the AI
```

Multitenancy in one sentence: the key lives only inside step 2's
per-request context, so two users on the same warm server can never see
each other's anything.

---

## Level 3: where the tools come from

The 49 generated tools are produced, not written:

```
@runpod/typescript-api-sdk/spec/openapi.yaml
                                   the API's description of itself
        +                          (shipped in the SDK package;
specgen/generator-config.yaml       runpod/js-sdk vendors it from
                                    api.runpod.io/v2/openapi.json
                                    through its patch layer)
  our judgment:
  - skip these operations (each skip needs a written reason)
  - override these descriptions ("BILLABLE: state the price first")
        │
        │   pnpm generate:tools        ← run BY A HUMAN, occasionally
        ▼
src/specgen/generated/tools.gen.ts     committed to git
  one data object per operation:
  { name, description, method, path, params, inputSchema }
```

No handler functions are generated — `dispatch.ts` executes any of these
objects. New API endpoint → re-vendor the spec → regenerate → new tool,
zero new code.

The 17 hand-written tools (`src/specgen/tools/`) exist only where
generation cannot reach:

| why hand-written                  | tools                                   |
| --------------------------------- | --------------------------------------- |
| no OpenAPI doc for that plane      | run/runsync/status/stream/cancel jobs   |
| GraphQL-only capability            | capacity matrix, Hub       |
| non-JSON transport (SSE)           | stream-pod-logs, stream-worker-logs     |
| raw output too big for a model     | list-templates, list-endpoints (trimmed)|

---

## Level 4: how updates and safety checks work

Three moments where things are checked, weakest to strongest:

```
DAILY ─ "did the API change under us?"
  runpod/js-sdk compares its vendored spec with the live openapi.json
  every day and every PR, and its spec update workflow releases a new
  @runpod/typescript-api-sdk when production moves. Here, the daily
  .github/workflows/spec-update.yml moves to the latest SDK release,
  regenerates the tools, and opens a PR.

EVERY PR ─ "is the repo consistent with itself?"   (pnpm test, no network)
  - every spec operation is generated OR excluded-with-a-reason
  - every tool schema compiles as valid JSON Schema
  - keyless server still lists tools; a keyless call 401s cleanly
  - waits stay under the hosting platform's 60s kill deadline
  - a tool-call log line never contains the key or the arguments

WHEN THE SDK MOVES ─ the update loop
  bump @runpod/typescript-api-sdk   (the daily workflow does this)
  pnpm generate                     tools
  ...then review generator-config.yaml: does the new operation need a
  billable warning? an exclusion? That judgment is deliberately manual.
```

One trap this caught already: the spec has a DEV generation
(`v2-rest.runpod.dev`, paths like `/v2/gpu-types`) and a PROD generation
(`api.runpod.io`, paths like `/v2/catalog/gpus`). Production is the
default everywhere; to build against dev (or any host), pull that spec in
runpod/js-sdk and point the generator at the file:

    SPEC_URL=https://v2-rest.runpod.dev/v2/openapi.yaml pnpm spec:pull   # in js-sdk
    RUNPOD_SPEC_PATH=.../openapi.yaml pnpm generate                      # here
    RUNPOD_API_BASE_URL=...           # and point the RUNTIME at the same
                                      # environment, or the tools will call
                                      # prod paths that dev does not serve

### The other half of the update loop: the SDK

Two generators read the one spec, and they generate different things.

The MCP generates **tool definitions**: `src/specgen/generated/tools.gen.ts`
is an array of plain objects — tool name, description written for a language
model, JSON Schema for the arguments, and the method and path to call. It is
data, read at runtime to answer `tools/list` and to route a call.

The SDK, in runpod/js-sdk,
generates **types**: its `src/generated/schema.ts` is TypeScript declarations
and no runtime code, which is what makes `ctx.sdk.GET('/v2/pods')` know the
path exists, which query parameters it takes, and what comes back.

The two are stacked. Our generated tools say what to call; the call itself
goes out through the SDK, a devDependency bundled into the build. The tools
generate from the spec the installed SDK ships, so the tools and the SDK
types always describe the same API. A new upstream parameter reaches both
halves once the SDK releases it and the devDependency moves:

```
GENERATED TOOLS (src/specgen/generated/)
  Dispatch reads the method and path from the spec, not from SDK types.
  The tool has the new parameter as soon as it is regenerated.

CURATED TOOLS (src/specgen/tools/)
  Hand-written handlers calling ctx.sdk.GET(...). The regenerated SDK
  types accept the new parameter at once; the handler still has to be
  taught to pass it.
```

When an SDK bump touches an endpoint a curated tool serves, check
`src/specgen/tools/` for a handler on the affected path before assuming the
bump was enough.

---

## Level 5: the skills

The journey playbooks teach an agent HOW to use the
tools well — e.g. pod-doctor: "if torch can't see the GPU, check gpuCount
before blaming CUDA; never terminate, that destroys the disk."

They live in runpod-plugins-official as skills (`runpod-mcp` is the router,
plus one skill per journey) and reach this server in `@runpod/plugin-knowledge`,
served by the `list-guides`/`read-guide` tools and as resources:

```
read-guide runpod-mcp                 → the router: maps any request
                                        to the right playbook
resources/read runpod://guides/<id>   → the same guides as resources
```

Agents are pointed at them by the `instructions` string in the very first
handshake response ("PLAYBOOKS — READ BEFORE ACTING… load the plugin's
runpod-mcp skill, otherwise read-guide runpod-mcp, before your first tool call"). This is a strong nudge, not a guarantee —
which is why the critical warnings (billable, destructive) are ALSO inlined
in the tool descriptions, where even a skill-ignoring agent sees them.

A playbook change ships as a plugin release plus a package bump here, so the
plugin and this server serve one copy.

---

## Level 6: hosting constraints worth knowing

- **60-second reaper.** Vercel kills any request at 60s. All job-wait tools
  clamp to 45s when hosted (`HOSTED` flag in `src/specgen/tools/jobs.ts`),
  and every poll is bounded by the remaining budget so one hung socket
  cannot outlive the deadline. On local stdio the budgets are 5 minutes.
- **Stateless by design.** A fresh server object per request, discarded
  after. Nothing user-scoped may live at module scope — that is the
  tenancy rule, and it is tested.
- **Rate limiting is layered.** Unauthenticated traffic is already limited
  outside this repo: the Vercel project firewall (WAF) enforces 60 req/min
  per IP on POSTs to `/` that carry no Authorization header (429), logs the
  same limit on GETs, and runs the OWASP managed rules in log mode. That
  config is project-scoped, so it covers previews and prod alike — it is
  not in git; see the project's Firewall tab. Authenticated per-caller
  limiting is the stub: `src/specgen/ops.ts` defines the seat (consulted
  before every call, denial → retryable error with a wait hint);
  enforcement is a later one-function swap to a KV-backed counter.
- **The SDK lives in runpod/js-sdk.** `@runpod/typescript-api-sdk` is a
  devDependency bundled into both entrypoints, and ships the spec the tools
  generate from. It owns management API retries,
  request deadlines, and SSE parsing; MCP retains snapshot limits and
  agent-facing formatting. Node.js 20+ is required.
- **One surface everywhere.** stdio and hosted serve the same tools and
  skill resources; the legacy hand-written surface (`src/tools.ts`) is
  deleted. The only intended difference is wait budgets: 45 s hosted
  (gateway reaper), 5 minutes on stdio.

---

## Appendix: file map + commands

```
(hosted service repository)      Box 1: Vercel adapter + OAuth routes
src/http.ts                      Box 1: auth, transport, per-request server
src/specgen/server.ts            Box 2: tool list, routing, resources,
                                        instructions, hints, logging
src/specgen/dispatch.ts          Box 2: the one executor for generated tools
src/specgen/context.ts           Box 2: per-request clients from the caller's key
src/specgen/tools/               Box 2: the 17 hand-written tools
src/specgen/ops.ts               Box 2: log line + rate-limit stub
src/specgen/generated/           Box 2: machine-written output (DO NOT EDIT)
@runpod/typescript-api-sdk/spec/openapi.yaml
                                 Box 3: production spec (patched), from the SDK package
specgen/generator/spec-path.ts   Box 3: where the generator finds that spec
specgen/generator-config.yaml    Box 3: exclusions / description + argument overrides / on-demand schemas
specgen/generator/               Box 3: the generator
tests/specgen-*.test.ts          the gates described in level 4
```

```
pnpm generate          regenerate the tool surface from the SDK's spec
pnpm generate:check    are the generated tools current?
pnpm test              all gates (no network, no credentials needed)
npx vercel deploy      preview deployment (prod promotion is manual)
```
