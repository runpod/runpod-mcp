# Spec-generated tool surface (specgen)

> New here? Read [DESIGN.md](DESIGN.md) — a progressive walkthrough of the architecture, data flow, and update loop.

This directory and `src/specgen/` hold the spec-driven tool architecture
mounted on the hosted (HTTP) path: every v2 OpenAPI operation becomes an MCP
tool by generation, plus a curated overlay for the planes the spec does not
cover. stdio and hosted serve the same surface — these tools and the skill
resources. The only intended difference is wait budgets: 45 s hosted
(gateway reaper), 5 minutes on stdio.

## Layout

```
node_modules/@runpod/typescript-api-sdk/spec/openapi.yaml
                                v2 OpenAPI document shipped in the SDK package
                                (vendored and patched in runpod/js-sdk)
specgen/generator-config.yaml   exclusions / renames / description overrides
specgen/generator/              the generator (pnpm generate:tools)
src/specgen/generated/          machine-written output — never hand-edited
src/specgen/tools/              curated overlay (runtime plane, GraphQL, SSE,
                                trimmed list views)
src/specgen/ops.ts              tool-call logging + the rate-limit stub seam
```

## REST client dependency

The management API client is
[`@runpod/typescript-api-sdk`](https://www.npmjs.com/package/@runpod/typescript-api-sdk),
which lives in [runpod/js-sdk](https://github.com/runpod/js-sdk). The MCP takes it
as a devDependency and bundles it into both entrypoints. The tools generate from the
`spec/openapi.yaml` the package ships, so the tools and the client always describe
the same API, and an API change reaches the MCP when it moves to an SDK release
that contains it. Node.js 20+ is required.
Each tool context creates its own client with the caller's API key and tracking
headers. The SDK owns retries, the whole-request deadline, and SSE event parsing;
MCP owns bounded log snapshots, agent-facing error hints, and the separate
Serverless runtime and GraphQL clients.

## Workflows

```bash
pnpm generate          # regenerate src/specgen/generated/tools.gen.ts from the SDK's spec
pnpm generate:check    # fail if the generated tools are stale
pnpm test              # includes the specgen drift gates
```

Spec pulls, the patch layer (`scripts/fix_spec.py`), and the drift check against
the live API live in runpod/js-sdk. Fix the spec there.

New API endpoint: release it in `@runpod/typescript-api-sdk`, bump the
devDependency here, then `pnpm generate`. The daily **Production spec update**
workflow does this bump on its own. The gates fail if an operation is neither
generated nor excluded with a reason, or if a curated replacement disappears.

To generate against an unreleased spec, set `RUNPOD_SPEC_PATH` to its file.

## Playbooks over MCP

The journey playbooks live in runpod-plugins-official and reach this server
through `@runpod/plugin-knowledge`: `list-guides`/`read-guide` serve them, and
so do the `runpod://guides/<id>` resources. The initialize briefing directs
agents to the plugin's `runpod-mcp` skill, or to `read-guide runpod-mcp`
without the plugin, before their first tool call. Edit a playbook in the
plugin repo, release it, and bump the package here.

## Hosted behavior

- Per-request `ToolContext` from the caller's bearer token; no credential at
  module scope.
- Server-side waits clamp to 45 s behind the 60 s gateway deadline (stdio
  keeps 5-minute budgets); tool descriptions state the real ceiling.
- One structured log line per tool call (tool, salted caller hash, status,
  latency — never the key or arguments); rate limiting is a no-op stub with
  the enforcement seat already in the request path (`src/specgen/ops.ts`).
