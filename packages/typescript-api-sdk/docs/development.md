# Development

Use Node 24 for development, pnpm 11.0.0 (recorded in `packageManager`), and
Python 3.11. Python's dependency is pinned in `scripts/requirements.txt`.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r scripts/requirements.txt
pnpm install --frozen-lockfile
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

```bash
pnpm spec:check                 # compare the public production spec, no credentials
pnpm spec:pull                  # validate before atomically replacing vendored YAML
pnpm generate                  # regenerate src/generated/schema.ts
pnpm generate:check             # fail if checked-in types differ from fresh output
```

The source is `https://api.runpod.io/v2/openapi.json`. The drift check compares
whole normalized documents, including referenced schemas and descriptions;
changes require review even if they only affect documentation. It never rewrites
files. Network failures fail the check rather than claiming the contract is current.

The **Daily production spec update** workflow runs at approximately 09:23 UTC
once this workflow is on the default branch. It can also be dispatched manually
from that branch. It pulls the production spec, regenerates types, and runs all
checks on Node 24 before opening or updating one PR on
`automation/production-spec`. No changes means no new PR; a superseded update
PR is closed when its diff disappears. Failed downloads, generation, or tests
fail the run before updating the PR.

The workflow explicitly dispatches `SDK checks` on the update branch for Node
20/22/24, rather than relying on bot-generated PR events. Review that matrix
before merging. When the spec changed, the update PR also carries a minor
version bump and changelog entry, consuming any changesets pending on the
default branch. Merging it publishes that version (see
[releases](releases.md)). Nothing merges automatically, so review the
compatibility impact before merging. If the change needs a bigger bump than
minor, land a changeset with that bump on the default branch and dispatch the
workflow again; Changesets takes the highest pending bump. Bot-branch edits can
be overwritten on the next refresh; land durable fixes on the default branch
instead.

To enable automated update PRs, allow GitHub Actions to create pull requests.
The update job needs `contents: write`, `pull-requests: write`, and `actions: write`.
Require the `verify (20)`, `verify (22)`, and `verify (24)` checks plus human review
before merging updates. Dismiss stale approvals when new commits are pushed.

`scripts/fix_spec.py` is the reviewed patch layer: auth response declarations,
placeholder examples, enum names, and public descriptions. Patches fail when
their upstream anchors change. Regenerate instead of editing vendored YAML or
`src/generated/schema.ts` by hand. The generator preserves YAML boolean-like
strings and preserves required properties through nested `allOf`/`$ref` inheritance; properties with defaults
remain optional unless the spec requires them. Generation also rejects query
encodings that need a different runtime serializer.

CI verifies generated freshness, Python and TypeScript tests, and installed
ESM/CJS consumers on Node 20, 22, and 24. The separate SDK release workflow validates the same matrix before publishing.

## The other generator: runpod-mcp

Two repositories generate from the same `https://api.runpod.io/v2/openapi.json`,
and they produce different things for different consumers. Knowing which is
which saves an afternoon when an API change looks half-applied.

This repository generates **types**. `spec/openapi.yaml` becomes
`src/generated/schema.ts`, a file of TypeScript declarations with no runtime
code. It is what lets `sdk.GET("/v2/pods")` know that the path exists, which
query parameters it accepts, and what shape comes back. Everything around it
(retries, deadlines, rate-limit metadata, the SSE iterator) is written by hand.

The [MCP server](https://github.com/runpod/runpod-mcp) generates **tool
definitions**. Its own vendored copy of the spec becomes
`src/specgen/generated/tools.gen.ts`, an array of plain objects: tool name,
description written for a language model, JSON Schema for the arguments, and
the method and path to call. That array is data read at runtime to answer
`tools/list` and to route a call, not types erased at compile time.

The two are stacked rather than parallel: the MCP server's generated tools
describe what to call, and the call itself goes through this SDK, which it
pins as a devDependency and bundles into its build. So an upstream API change
usually has to be taken up **twice, in order**:

1. Here: pull the spec, regenerate, bump the version, and publish. The daily
   automation's spec PR carries the version bump, so merging it publishes.
2. In runpod-mcp: pull the spec and regenerate its tools, and bump the pinned
   SDK version when its hand-written tools need the new types.

Step 2's generated half picks up new paths and parameters on its own. Its
hand-written tools do not, and they are the ones that call this SDK, so they
stay on the old contract until a published version carries the new types. A
resync that stops after step 1, or after step 2's regeneration alone, leaves
part of the surface stale while looking complete.

## Release preparation

Use [Changesets](releases.md) to record release notes and compatibility changes.
The release workflow prepares version PRs and publishes after a release PR is
manually merged. It also supports manual retries and dry runs.
