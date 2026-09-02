# Spec-generated tool surface (specgen)

> New here? Read [DESIGN.md](DESIGN.md) — a progressive walkthrough of the architecture, data flow, and update loop.

This directory and `src/specgen/` hold the spec-driven tool architecture
mounted on the hosted (HTTP) path: every v2 OpenAPI operation becomes an MCP
tool by generation, plus a curated overlay for the planes the spec does not
cover. The stdio entrypoint serves the pre-existing hand-written surface by
default; set `RUNPOD_MCP_SURFACE=specgen` to run this surface locally
(same tools and skills as hosted, 5-minute wait budgets). It becomes the
default at the next major release.

## Layout

```
specgen/spec/openapi.yaml       vendored v2 OpenAPI document (production generation)
specgen/scripts/fix_spec.py     spec patch layer, run over every fresh pull
specgen/generator-config.yaml   exclusions / renames / description overrides
specgen/generator/              the generator (pnpm generate:tools)
specgen/skills/                 the ten journey skills, served as MCP resources
specgen/old-mcp-tools.yaml      54-tool parity manifest vs. the old surface
src/specgen/generated/          machine-written output — never hand-edited
src/specgen/tools/              curated overlay (runtime plane, GraphQL, SSE,
                                trimmed list views)
src/specgen/ops.ts              tool-call logging + the rate-limit stub seam
vendor/runpod-sdk/              locally built @runpod/sdk (npm publish pending)
```

## Workflows

```bash
pnpm spec:pull         # re-vendor the spec (production; SPEC_URL=... overrides)
pnpm spec:check        # diff the vendored spec against the live one
pnpm generate:tools    # regenerate src/specgen/generated/tools.gen.ts
pnpm generate:skills   # re-embed specgen/skills into skills.gen.ts
pnpm test              # includes the specgen drift gates
```

New API endpoint: pull the spec, run the patch layer
(`python3 specgen/scripts/fix_spec.py specgen/spec/openapi.yaml`), then
`pnpm generate:tools`. The gates fail if an operation is neither generated nor
excluded with a reason, if a curated replacement disappears, or if the old
54-tool surface loses a mapping.

## Skills over MCP

The ten skills embed into the build and serve as resources at
`runpod://skills/<name>`; the initialize briefing directs agents to read
`runpod://skills/runpod` (the router) before their first tool call. Local
installs can still copy `specgen/skills/` into an agent's skills directory.

## Hosted behavior

- Per-request `ToolContext` from the caller's bearer token; no credential at
  module scope.
- Server-side waits clamp to 45 s behind the 60 s gateway deadline (stdio
  keeps 5-minute budgets); tool descriptions state the real ceiling.
- One structured log line per tool call (tool, salted caller hash, status,
  latency — never the key or arguments); rate limiting is a no-op stub with
  the enforcement seat already in the request path (`src/specgen/ops.ts`).
