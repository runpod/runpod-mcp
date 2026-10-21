# Development

This package lives in the
[runpod-mcp repository](https://github.com/runpod/runpod-mcp) at
`packages/typescript-api-sdk/`, as a pnpm workspace package. Install from the
repository root with Node 20+ and pnpm 10; installing also builds this package
(its `prepare` script), because the MCP server imports it. Python 3.11 is needed
for the spec scripts, with its dependency pinned in `scripts/requirements.txt`.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r packages/typescript-api-sdk/scripts/requirements.txt
pnpm install --frozen-lockfile    # from the repository root
pnpm sdk:check                    # every check below, from the root
```

Or run them one at a time from `packages/typescript-api-sdk/`:

```bash
pnpm generate:check
pnpm test:spec
pnpm test:scripts
pnpm typecheck
pnpm test
pnpm test:package               # builds, packs, installs in a temporary consumer
pnpm test:examples              # uses built dist and mocked responses
```

`test:package` accesses npm to install the tarball's dependencies and the locked
TypeScript compiler. Other tests above use no live Runpod API and require no key.
Task is an optional command runner; `Taskfile.yml` provides shortcuts and loads
`.env`. Merely having an API key set does not enable live tests. Explicitly opt in
with `RUNPOD_LIVE_TESTS=1` and `RUNPOD_API_KEY` to run the read-only catalog smoke.
Do not put these credentials into ordinary CI.

## Updating the API contract

From the repository root:

```bash
pnpm spec:check                 # compare against the public production spec, no credentials
pnpm spec:pull                  # validate before atomically replacing vendored YAML
pnpm generate                   # regenerate src/generated/schema.ts and the MCP tools
```

From this directory, `pnpm spec:check` compares whole normalized documents,
including referenced schemas and descriptions, and `pnpm generate` regenerates
only `src/generated/schema.ts`. The root `spec:check` reports drift per
operation, which is what the MCP's tools depend on.

The source is `https://api.runpod.io/v2/openapi.json`; set `SPEC_URL` to pull
from another host. The checks never rewrite files, and network failures fail the
check rather than claiming the contract is current.

The runpod-mcp **Production spec update** workflow runs daily at about 09:23 UTC
and can be dispatched manually. It pulls the production spec, regenerates this
package's types and the MCP tools, runs both packages' checks, and opens or
updates one PR on `automation/production-spec`. No changes means no new PR.

`scripts/fix_spec.py` is the reviewed patch layer: auth response declarations,
placeholder examples, enum names, and public descriptions. Patches fail when
their upstream anchors change. Regenerate instead of editing vendored YAML or
`src/generated/schema.ts` by hand. The generator preserves YAML boolean-like
strings and preserves required properties through nested `allOf`/`$ref` inheritance; properties with defaults
remain optional unless the spec requires them. Generation also rejects query
encodings that need a different runtime serializer.

CI (the `sdk` job in runpod-mcp's `ci.yml`) verifies generated freshness, Python
and TypeScript tests, and installed ESM/CJS consumers on Node 20, 22, and 24.

## The other generator: the MCP tools

Two generators read `spec/openapi.yaml`, and they produce different things.

This package generates **types**. `spec/openapi.yaml` becomes
`src/generated/schema.ts`, a file of TypeScript declarations with no runtime
code. It is what lets `sdk.GET("/v2/pods")` know that the path exists, which
query parameters it accepts, and what shape comes back. Everything around it
(retries, deadlines, rate-limit metadata, the SSE iterator) is written by hand.

The MCP server at the repository root generates **tool definitions**:
`src/specgen/generated/tools.gen.ts`, an array of plain objects with the tool
name, a description written for a language model, JSON Schema for the
arguments, and the method and path to call. Its calls go out through this
package, which it takes as a `workspace:*` dependency and bundles into its
build. `pnpm generate` at the root regenerates both, so one PR takes up an API
change for both. The MCP's hand-written tools still need code changes to pass a
new parameter.

## Release preparation

Use [Changesets](releases.md) to record release notes and compatibility changes.
