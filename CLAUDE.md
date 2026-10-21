# Runpod MCP server

This is the official Runpod MCP (Model Context Protocol) server, published to npm as `@runpod/mcp-server`. It allows LLMs to manage Runpod infrastructure through the MCP standard, including Pods, Serverless endpoints, templates, network volumes, and container registry authentications.

## Documentation style

Always use sentence case for headings and titles.

Always use proper nouns when discussing specific Runpod products and features:

- Runpod (never Runpod).
- Pod/Pods (never lowercase "pod/pods").
- Serverless (never lowercase "serverless").
- Hub, Instant Clusters, Secure Cloud, Community Cloud, Tetra, Flash.
- Apply proper noun styling only to text that the user will see, not things like image/documentation links.

These are generic terms (use lowercase):

- endpoint, worker, cluster, template, handler, fine-tune, network volume.

Prefer using paragraphs to bullet points unless directly asked. When using bullet points, end each line with a period.

## Architecture

The server communicates with two separate Runpod API backends. The REST v2 API at `https://api.runpod.io/v2` handles all authenticated CRUD operations for Pods, endpoints, templates, network volumes, clusters, SSH keys, and container registries; the tools covering it are generated from its OpenAPI spec (`pnpm generate:tools`, see `specgen/DESIGN.md`). It requires a `RUNPOD_API_KEY` environment variable. The GraphQL API at `https://api.runpod.io/graphql` is reached two ways. The public, unauthenticated path serves read-only discovery queries — GPU capacity by CUDA version, the Hub catalog, Public Endpoints. The authenticated path (`graphqlAuthed`, API key as a Bearer token) serves the handful of write operations that have no REST equivalent: `deploy-hub-repo`, which calls the `saveEndpoint` mutation. The two resolve their host from separate env vars on purpose — see `RUNPOD_PUBLIC_GRAPHQL_URL` and `RUNPOD_AUTHED_GRAPHQL_URL` below.

The source is split by responsibility:

- `src/stdio.ts` is the local `stdio` entrypoint.
- `src/http.ts` does bearer-token extraction and the per-request MCP session for the Streamable HTTP transport. It validates the request body once, at the boundary, with the SDK's Zod schemas (`parseMcpMessages`); everything after that works on typed messages, so a `typeof` check inside handler logic means validation happened too late.
- `src/specgen/` is the tool surface — generated from the v2 OpenAPI spec plus a curated overlay; see `specgen/DESIGN.md`. There is one surface: stdio and hosted serve the same tools and skill resources.
- `src/server.ts` owns the server name/version constants.
- Tests, scripts and the specgen generator import source modules through the `#src/...` alias (`package.json` `imports`, mapped to `src/*.ts`, so the specifier is bare); a relative `../src` import there is a lint error. `api/` and `convex/` keep relative imports because Vercel and Convex bundle them with their own resolvers.
- `api/index.ts` is the Vercel adapter and hosts the OAuth authorization-server routes (`/.well-known/*`, `/register`, `/authorize`, `/token`).
- `packages/typescript-api-sdk/` is the REST v2 client, published separately to npm as `@runpod/typescript-api-sdk`. The repo is a pnpm workspace: the MCP at the root takes the SDK as a `workspace:*` devDependency and bundles it into `dist`, so the MCP package does not depend on an SDK release. The SDK owns the vendored spec (`packages/typescript-api-sdk/spec/openapi.yaml`) and its patch layer (`scripts/fix_spec.py`); both the SDK types and the MCP tools generate from that one file. The SDK keeps its own tooling (vitest, Python spec scripts, MIT license); see `packages/typescript-api-sdk/docs/development.md`.

### Hosted/OAuth environment variables

The hosted HTTP path (`api/index.ts` + `src/http.ts`) reads these, all optional with production-safe defaults:

- `RUNPOD_GRAPHQL_URL`: flash auth backend for the OAuth flow (default `https://api.runpod.io/graphql`). Also the host the hosted credential pre-flight verifies against, so unlike the guest flash-auth mutations it now receives the caller's bearer token — point it only at a host you trust with that.
- `CONSOLE_BASE_URL`: console that hosts the sign-in handoff page (default `https://console.runpod.io`).
- `RUNPOD_API_BASE_URL` / `RUNPOD_SERVERLESS_API_URL`: override the REST and Serverless API hosts (e.g. for a dev API key).
- `RUNPOD_PUBLIC_GRAPHQL_URL`: override the public discovery GraphQL host used by `get-capacity`, `list-hub-repos`, and `list-public-endpoints` (default `https://api.runpod.io/graphql`). Never carries a credential — safe to point at a stub, though note `get-capacity` has no REST fallback on either API version.
- `RUNPOD_AUTHED_GRAPHQL_URL`: override the GraphQL host for **authenticated** operations with no REST equivalent — `deploy-hub-repo` (default `https://api.runpod.io/graphql`). These send the caller's API key as a Bearer token, so only point this at a host you trust with it; on the hosted server that key is a per-user OAuth-minted one.
- `RUNPOD_API_KEY_NAME`: name for the minted key (default `runpod-mcp`; set to `""` to omit for a backend without the `apiKeyName` argument).
- `MCP_VERBOSE_LOGS`: set to `true` to log OAuth request ids (live auth codes) for debugging, and every `mcp_request` line regardless of the sample rate.
- `MCP_REQUEST_LOG_SAMPLE_RATE`: fraction of hosted requests that emit an `mcp_request` log line (default `0.1`, clamped to `0`–`1`). Each line carries `sampleRate` so counts can be scaled back up; `tool_call` and `credential_check` lines are never sampled.
- `MCP_FLASH_TIMEOUT_MS`: deadline in milliseconds for one call to the flash auth backend during the OAuth flow (default `10000`). Raise it for a slow backend; a value that is not a positive number is ignored, so the deadline cannot be disabled by a typo. The `/token` poll additionally caps itself at 45 seconds total, below the function's `maxDuration`.
- `POSTHOG_API_KEY` / `POSTHOG_HOST`: enable anonymous per-tool-call usage analytics on the hosted path (see `src/specgen/analytics.ts` for the privacy contract). Unset (the default everywhere but the production Vercel project) means nothing is ever sent. `MCP_ANALYTICS_SALT` sets the HMAC salt for the anonymous caller id (falls back to the PostHog key); clients opt out per request with the `X-Runpod-Analytics: off` header.
- `ALP_SINK_URL` / `ALP_SINK_SECRET`: enable the ALP tools (`report_feedback`, `save_to_journal`, `ask_question`, `read_journal`, `report_how_user_found_runpod`) on the hosted path and point `POST /api/alp/submit` at the private storage sink, authenticated with the shared secret. The same sink answers the once-per-account lookup the handshake makes for the referral ask (`/alp/answered`, `src/alp/answered.ts`), so when it is configured every `initialize` with a resolved account costs one sink round trip. Unset = the tools are absent and the endpoint answers `recorded: false` honestly. ALP is hosted-only: local stdio never registers these tools. The sink itself lives in `convex/` in this repo (deployed separately via `CONVEX_DEPLOY_KEY`; see `convex/README.md`).
- `KNOWLEDGE_SEARCH_URL` / `RUNPOD_ASSISTANT_API_KEY`: enable `search-docs` on the hosted path and `POST /api/search`. The URL is the runpod-assistant Convex deployment's `.convex.site` origin; the key is that deployment's service key and never leaves this server. Unset = the hosted tool is absent and `/api/search` answers 503. Local stdio lists `search-docs` and calls `POST /api/search` on the hosted server (`RUNPOD_MCP_URL`, default `https://mcp.getrunpod.io/`) with the user's own API key, so only point `RUNPOD_MCP_URL` at a host you trust with it.
- `MCP_SKIP_CREDENTIAL_CHECK`: set to the exact string `true` to disable the hosted pre-flight credential verification (dead bearers then surface as tool-level 401 errors instead of an HTTP 401 re-auth signal). Use this if the pre-flight itself is ever causing outages. Note the pre-flight ALSO self-disables when a REST/Serverless host is overridden without a matching `RUNPOD_GRAPHQL_URL`, since it would otherwise validate the key against the wrong environment and reject every request.

The build produces `dist/stdio.*` and `dist/http.*`. Because `package.json` has `"type": "module"`, always use `dist/stdio.mjs` when running the built local server with `node`.

## Local development

```bash
pnpm install
pnpm build
```

`pnpm install` also builds the SDK package (its `prepare` script), which the MCP's tests, type-check and build import. After changing SDK source, rebuild it with `pnpm --filter @runpod/typescript-api-sdk build`. Spec pulls and the drift check need Python 3 with PyYAML: `pip install -r packages/typescript-api-sdk/scripts/requirements.txt`.

To point Claude Code to your local build:

```bash
claude mcp add runpod -s user \
  -e RUNPOD_API_KEY=YOUR_API_KEY \
  -- node /absolute/path/to/runpod-mcp/dist/stdio.mjs
```

After making changes, rebuild with `pnpm build`. If you are in an active Claude Code session, type `/mcp` to reconnect without restarting. You can also use `pnpm build:watch` for auto-rebuilding during development.

## Adding tools

Most tools are NOT written by hand. The surface under `src/specgen/generated/` is emitted from the vendored v2 OpenAPI spec by `pnpm generate:tools`; a new REST endpoint becomes a tool by re-vendoring the spec (`pnpm spec:pull`) and regenerating the SDK schema and the tools (`pnpm generate`). Judgment (exclusions with reasons, description overrides for billable/destructive operations, renames) lives in `specgen/generator-config.yaml` — never edit generated files. Generated tool titles are derived from the tool name (`src/specgen/titles.ts`); override one under `titles` only when the derived name reads wrong. The generator compacts every argument description to what an agent needs (`specgen/generator/prose.ts`: leading sentences up to a cap, REST paths replaced by tool names); when that cut loses a constraint, give the field a hand-written entry under `propertyDescriptions`, keyed by schema address. A byte-budget gate in `tests/specgen-gates.test.ts` pins the served surface; raise a budget only with the reason in the PR. A tool whose request body is a large nested object that few sessions send goes under `schemaOnDemand` in the generator config (a curated tool sets the flag on itself): tools/list carries its call shape only, and `describe-tool` serves the full schema, which still gates every call.

Hand-written tools (`src/specgen/tools/`) exist only where generation cannot reach: the Serverless runtime plane, GraphQL-only capability, SSE log streams, trimmed list views, and GPU-selection convenience arguments. They implement the `CuratedTool` interface (a sentence-case `title`, JSON Schema `inputSchema`, a handler taking the per-request `ToolContext`) and register in `curatedTools` in `src/specgen/server.ts`. A tool that long-polls or streams (it can hold its response longer than a client's request timeout) sets `holdsResponse: true`; the hosted transport answers those over SSE and everything else as compressible JSON. The spec-parity gate fails if a spec operation is neither generated nor excluded, and the old-surface parity map (`specgen/old-mcp-tools.yaml`) fails if a mapped tool disappears.

## Known issues

DELETE endpoints may return 204 No Content. The SDK handles bodyless responses; generated dispatch reports their HTTP status.

Pod `publicIp` and `portMappings` fields are empty while the container is initializing. This is Runpod API behavior, not an MCP server bug. Pods need to be polled until they are fully running.

## Changesets and versioning

This project uses [changesets](https://github.com/changesets/changesets) for version management and npm publishing. Every PR that changes user-facing behavior needs a changeset, including new tools, modified tool params or descriptions, bug fixes in tool handlers, and changes to API request logic. Documentation-only changes, dev tooling changes, and test files do not need changesets.

The interactive `npx changeset` command does not work in non-TTY environments like Claude Code. Create the changeset file manually instead:

`.changeset/DESCRIPTIVE_NAME.md`

```markdown
---
'@runpod/mcp-server': minor
---

Description of what changed and why.
```

Use `patch` for bug fixes, `minor` for new tools, params, or features, and `major` for breaking changes to existing tool interfaces.

A change to `packages/typescript-api-sdk/` that consumers of the SDK would see needs its own entry, `'@runpod/typescript-api-sdk': <bump>`, in the same or a separate changeset. The SDK versions independently of the MCP; see `packages/typescript-api-sdk/docs/releases.md` for its bump rules. A spec resync changes both packages, so it lists both.

The `.changeset/` directory is tracked in git — it is the source the release workflow consumes — so stage changeset files normally with `git add`.

After merging to `main`, the changesets bot opens a "Version Packages" PR that bumps each changed package's `package.json` and `CHANGELOG.md`. Merging that PR triggers `changeset publish`, which publishes every workspace package whose version is not on npm yet (`@runpod/mcp-server`, `@runpod/typescript-api-sdk`) and tags each as `<package>@<version>`.

## PR conventions

Use branch names like `feat/description` or `fix/description`. Include one changeset per PR. Follow conventional commit messages: `feat: ...`, `fix: ...`, `chore: ...`. Include a test plan in the PR description listing what was manually verified.
