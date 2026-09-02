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
   │ api/index.ts + src/http.ts   (hosted, OAuth) │
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
   │ specgen/spec/openapi.yaml   the API's menu   │
   │ specgen/generator-config.yaml  our judgment  │
   │ specgen/generator/          the script       │
   │ specgen/skills/             the playbooks    │
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

5. the SDK (vendor/runpod-sdk, bundled into the build)
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
specgen/spec/openapi.yaml          the API's description of itself
        +                          (vendored from
specgen/generator-config.yaml       api.runpod.io/v2/openapi.json)
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
| GraphQL-only capability            | capacity matrix, Hub, GPU pinning       |
| non-JSON transport (SSE)           | stream-pod-logs, stream-worker-logs     |
| raw output too big for a model     | list-templates, list-endpoints (trimmed)|

---

## Level 4: how updates and safety checks work

Three moments where things are checked, weakest to strongest:

```
DAILY + EVERY PR ─ "did the API change under us?"
  .github/workflows/spec-drift.yml  +  a step in ci.yml
  downloads the live openapi.json, diffs operation-by-operation
  against our vendored copy; prints exactly what appeared,
  disappeared, or moved. Real drift fails CI; an unreachable
  spec only warns (a network blip is not a verdict).

EVERY PR ─ "is the repo consistent with itself?"   (pnpm test, no network)
  - every spec operation is generated OR excluded-with-a-reason
  - all 54 tools of the old server still map to a served tool
  - every tool schema compiles as valid JSON Schema
  - keyless server still lists tools; a keyless call 401s cleanly
  - waits stay under the hosting platform's 60s kill deadline
  - a tool-call log line never contains the key or the arguments

WHEN DRIFT IS RED ─ the human update loop (two commands)
  pnpm spec:pull          re-vendor (production by default)
  pnpm generate:tools
  ...then review generator-config.yaml: does the new operation need a
  billable warning? an exclusion? That judgment is deliberately manual.
```

One trap this caught already: the spec has a DEV generation
(`v2-rest.runpod.dev`, paths like `/v2/gpu-types`) and a PROD generation
(`api.runpod.io`, paths like `/v2/catalog/gpus`). Production is the
default everywhere; to build against dev (or any host), override with an
env var — the vendored file records its source in its header:

    SPEC_URL=https://v2-rest.runpod.dev/v2/openapi.yaml pnpm spec:pull
    SPEC_URL=... pnpm spec:check      # judge drift against that host too
    RUNPOD_API_BASE_URL=...           # and point the RUNTIME at the same
                                      # environment, or the tools will call
                                      # prod paths that dev does not serve

While dev-vendored, the drift check against production goes red — that
red is correct (you are deliberately drifted), not a bug.

---

## Level 5: the skills

Ten markdown playbooks (`specgen/skills/`) teach an agent HOW to use the
tools well — e.g. pod-doctor: "if torch can't see the GPU, check gpuCount
before blaming CUDA; never terminate, that destroys the disk."

They are served over MCP as resources, not tools:

```
resources/list                        → 10 entries (runpod://skills/<name>)
resources/read runpod://skills/runpod → the router: maps any request
                                        to the right playbook
```

Agents are pointed at them by the `instructions` string in the very first
handshake response ("SKILLS — READ BEFORE ACTING… read runpod://skills/runpod
before your first tool call"). This is a strong nudge, not a guarantee —
which is why the critical warnings (billable, destructive) are ALSO inlined
in the tool descriptions, where even a skill-ignoring agent sees them.

Like the tools, skills are embedded at dev time (`pnpm generate:skills` →
`skills.gen.ts`); a test fails if the embedded copy and the .md files
disagree.

---

## Level 6: hosting constraints worth knowing

- **60-second reaper.** Vercel kills any request at 60s. All job-wait tools
  clamp to 45s when hosted (`HOSTED` flag in `src/specgen/tools/jobs.ts`),
  and every poll is bounded by the remaining budget so one hung socket
  cannot outlive the deadline. On local stdio the budgets are 5 minutes.
- **Stateless by design.** A fresh server object per request, discarded
  after. Nothing user-scoped may live at module scope — that is the
  tenancy rule, and it is tested.
- **Rate limiting is a stub.** `src/specgen/ops.ts` defines the seat
  (consulted before every call, denial → retryable error with a wait hint);
  enforcement is a later one-function swap to a KV-backed counter.
- **The SDK is vendored.** `vendor/runpod-sdk` is the built TypeScript SDK,
  bundled into `dist` so the npm package and the deployment are
  self-contained. When `@runpod/sdk` is published to npm, delete the vendor
  dir and depend on it normally.
- **One surface everywhere.** stdio and hosted serve the same tools and
  skill resources; the legacy hand-written surface (`src/tools.ts`) is
  deleted. The only intended difference is wait budgets: 45 s hosted
  (gateway reaper), 5 minutes on stdio.

---

## Appendix: file map + commands

```
api/index.ts                     Box 1: Vercel adapter + OAuth routes
src/http.ts                      Box 1: auth, transport, per-request server
src/specgen/server.ts            Box 2: tool list, routing, resources,
                                        instructions, hints, logging
src/specgen/dispatch.ts          Box 2: the one executor for generated tools
src/specgen/context.ts           Box 2: per-request clients from the caller's key
src/specgen/tools/               Box 2: the 17 hand-written tools
src/specgen/ops.ts               Box 2: log line + rate-limit stub
src/specgen/generated/           Box 2: machine-written output (DO NOT EDIT)
specgen/spec/openapi.yaml        Box 3: vendored production spec
specgen/generator-config.yaml    Box 3: exclusions / description overrides
specgen/generator/               Box 3: the generator
specgen/skills/                  Box 3: the ten playbooks
specgen/old-mcp-tools.yaml       parity map against the old 54-tool server
vendor/runpod-sdk/               the built TS SDK (bundled; npm publish pending)
scripts/check-spec-drift.ts      live-vs-vendored spec diff
tests/specgen-*.test.ts          the gates described in level 4
```

```
pnpm generate:tools    regenerate the tool surface from the spec
pnpm generate:skills   re-embed the skills
pnpm spec:check        am I drifted from the live API?
pnpm test              all gates (no network, no credentials needed)
npx vercel deploy      preview deployment (prod promotion is manual)
```
