# @runpod/mcp-server

## 3.1.0

### Minor Changes

- 259241d: Enforce PKCE (S256) in every hosted OAuth flow. `/authorize` rejects missing, malformed, or non-S256 challenges before issuing a code and forwards a valid challenge to the flash backend. `/token` requires a valid, matching `code_verifier` before returning the minted key; missing PKCE state, `plain`, and non-matching verifiers are rejected.

  Requires the backend `codeChallenge` / `codeChallengeMethod` fields on `createFlashAuthRequest` / `flashAuthRequestStatus` (runpod/RunPod, DR-1398) to be deployed.

- f6208cd: Diagnose stuck queued jobs instead of leaving them ambiguous. A job that stays IN_QUEUE has two very different causes that its status alone cannot distinguish: no host has the endpoint's GPU available (capacity), or a worker spun up and is crash-looping — the platform marks it UNHEALTHY while the job stays queued indefinitely, and agents reliably misread that as a capacity shortage. `get-job-status` now best-effort attaches the endpoint's worker summary (`workerHealth`) and a plain-language `hint` whenever the job is IN_QUEUE (v2 only; the extra lookup never fails the status call, and the diagnosis is cached ~15s per endpoint so polling loops do not amplify into repeated worker-list fetches): UNHEALTHY workers → crash-loop guidance naming the worker ids to inspect with `stream-worker-logs`; zero workers → capacity guidance; throttled/initializing → wait guidance. The `get-job-status`, `endpoint-health`, `list-endpoint-workers`, and `stream-worker-logs` descriptions now cross-reference each other so agents are routed from a stuck job to the worker logs without prior knowledge of the platform's queueing behavior.
- f36f191: Send the reshaped v2 Serverless write schema, and support load-balancing endpoints.

  `/v2/serverless` changed its create/update contract: endpoint `type` (`QUEUE` or
  `LOAD_BALANCER`) is now required on create, the autoscaling object moved from a flat
  `{type, value, idleTimeout}` to a per-scaler `{type, queueDelay}` / `{type, requestCount}`,
  and `idleTimeout` moved under `workers`. `create-endpoint` and `update-endpoint` now emit
  that shape; previously they sent the older one and were rejected with a `422`.

  `create-endpoint` gains `endpointType` for queue-based (default) versus load-balancing
  request routing. `scalerType` defaults per endpoint type, `scalerValue` defaults to `4`, and
  passing `scalerValue` alone on `update-endpoint` keeps the endpoint's current scaler, so
  existing calls keep working unchanged. Responses carry `type` and `requestUrls`, and
  `get-endpoint` / `list-endpoints` now point at `requestUrls` as the source for an endpoint's
  URLs.

  **This requires a Runpod API host serving the new schema.** Against a host still on the older
  one, endpoint create/update return a `422` naming `queueDelay`/`requestCount`/`idleTimeout` as
  not allowed. `RUNPOD_REST_VERSION=v1` remains available for the legacy template-based model.

## 3.0.0

### Major Changes

- 119f633: Resync the tool surface with the current v2 REST spec.

  **Breaking:** removes the seven tag tools (`list-tags`, `get-tag`, `create-tag`, `update-tag`,
  `delete-tag`, `attach-tag`, `detach-tag`). `/v2/tags` no longer exists — it returns
  `404 "The requested path was not found."` on both the production and dev hosts — so the tools
  could not succeed for any caller.

  **New:** three AWS ECR delegation tools (`list-registry-delegations`,
  `create-registry-delegation`, `delete-registry-delegation`) for `/v2/registries/delegations`.
  Unlike `create-container-registry-auth`, this stores no credentials: you register an ECR
  repository ARN and Runpod is granted scoped pull access. v2-only.

  **New:** `create-network-volume` gains `volumeType` (`STANDARD` | `HIGH_PERFORMANCE`). The
  field was in the spec but no tool exposed it, so high-performance volumes could not be created
  here. Omit it for the data center default. Its documented size range is also corrected to
  10–4096 GB (was 1–4000).

  **Enabled:** `list-endpoint-releases` was implemented but left unregistered because
  `GET /v2/serverless/{id}/releases` used to be dev-only. It now returns 200 on production.

  `create-template` no longer sends `category: NVIDIA` when the caller omits it — v2 made the
  field optional with that same server-side default, so the value is no longer invented
  client-side. An explicit `category` still passes through.

### Minor Changes

- fbcf9b7: Add `RUNPOD_AUTHED_GRAPHQL_URL` to override the GraphQL host used by authenticated operations that have no REST equivalent (`deploy-hub-repo`, `set-endpoint-gpus`). These calls send the caller's API key as a Bearer token, so they no longer follow `RUNPOD_PUBLIC_GRAPHQL_URL` — that variable stays the credential-free discovery override, safe to point at a stub.
- 00e6ec2: Surface dead credentials as a proper HTTP 401 on the HTTP server so OAuth-capable MCP clients re-authenticate automatically.

  Previously, when a bearer token was revoked mid-session (e.g. an OAuth-minted key), every upstream Runpod call failed with a 401 that the MCP SDK wrapped into a 200 JSON-RPC tool error — the client never saw an HTTP 401, never re-ran its auth flow, and the user was stuck with bare "Unauthorized" tool errors until they manually reconnected. The request handler now pre-flight verifies the bearer (one `myself` GraphQL query, cached ~60s valid / ~30s invalid by token hash, never the raw token) and answers `401` + `WWW-Authenticate` with the protected-resource metadata when the credential is dead. `WWW-Authenticate` is exposed via CORS so browser clients can read it, and a rejected credential carries `error="invalid_token"` to distinguish it from a request that sent none (RFC 6750 §3.1). `ToolContext` gains an optional `onUnauthorized` callback, invoked when an outbound call returns 401, which drops the cached verdict so the next request re-checks.

  The check is deliberately conservative so it can never reject a working key:
  - It fails **open** on anything indeterminate — auth-backend errors, 5xx, 403 (this host sits behind a WAF, and a block is not a revocation), a slow backend (time-bound), and a GraphQL response carrying an `errors` array (a resolver blip returns `myself: null` for everyone at once; treating that as invalid would 401 every valid key). Failing closed on any of these would make OAuth clients re-run the flow, minting a new API key per attempt — an unrecoverable loop.
  - It runs only for the requests the transport would actually run a tool for: a `POST` whose `Content-Type` the SDK treats as JSON and whose body invokes a method (including inside a batch). Everything else is passed through unchecked.
  - It self-disables (logging `skip_env_mismatch`) when the REST/Serverless hosts and the auth-GraphQL host disagree about environment in either direction, since it would otherwise validate a key against the wrong backend.
  - Request bodies are capped at 4 MB (matching the SDK) on hosts that do not pre-parse them.
  - The verdict cache is safe under load: eviction never disowns an in-flight check, and TTLs use a monotonic clock, so a burst of distinct tokens or a wall-clock adjustment cannot let a since-revoked key linger as `valid`.

  Set `MCP_SKIP_CREDENTIAL_CHECK=true` to disable the pre-flight entirely.

  Notes for consumers of the published `./http` export (not only the hosted deployment): the pre-flight adds one outbound `myself` call to the Runpod GraphQL host per checked request, and a new dependency on that host being reachable (it fails open if not). This does **not** close the pre-existing key-validity oracle — a caller who speaks MCP can still learn 401-vs-not for a token, one upstream call each, with no rate limiting; closing that needs rate limiting, which this does not add.

- f3b226b: Add a `deploy-hub-repo` tool that deploys a Runpod Hub repo's listed release as a new Serverless endpoint — the same operation as clicking Deploy on the Hub. Identify the repo by `repo` ("owner/name") or `hubReleaseId` (both from `list-hub-repos`); the release supplies the prebuilt image, container disk, CUDA constraints, and env-var defaults, with caller overrides for env vars, GPU pools, worker counts, scaling, and FlashBoot. Required env vars without a default fail fast with an actionable message before anything is created, as do POD listings and releases without a GPU pool when none is provided. Uses the authenticated GraphQL `saveEndpoint` mutation (Hub deploys have no REST home yet), so it behaves identically on v1 and v2. The tool runtime gains a `graphqlAuthed` helper (API-key Bearer + variables) to support it.
- 725b6cd: Surface realtime GPU availability on the v2 catalog. `list-gpu-types` now requests `?include=AVAILABILITY` by default, so each GPU carries an `availability` summary (HIGH/MEDIUM/LOW/NONE) and results are sorted highest-stock-first. The full catalog is still returned by default — nothing is hidden — so the tool stays complete for discovery and capacity/price surveys. `includeUnavailable` is now an opt-in _hide_: pass `includeUnavailable: false` to drop out-of-stock GPUs and list only currently-deployable ones. A new `includeAvailability` param (default true) can opt out of the stock lookup entirely. `get-gpu-type` returns the per-datacenter availability breakdown (and URL-encodes ids, which contain spaces) so callers can pick a `dataCenterIds` with stock before creating a pod. Falls back gracefully when the backend doesn't populate availability.

  The v2 path also drops the `"unknown"` sentinel GPU (matching the v1 path) so it doesn't leak into the now-unhidden default list.

  Behavior change to note: `list-gpu-types` still returns every GPU by default, but results are now sorted highest-stock-first rather than in a stable order. Nothing is hidden by default.

- 546a40f: Add a `list-hub-repos` tool for discovering the Runpod Hub catalog (prebuilt Serverless workers and Pod templates such as vLLM, ComfyUI, and Axolotl). Served by the public GraphQL endpoint — no auth required — and available on both v1 and v2. Each result includes the repo metadata (stars, deploys, category, tags) plus the currently listed release with its `hubReleaseId` and prebuilt `imageName`, the two values a Hub deploy is pinned to. Supports `searchTerm`, `category`, `type` (SERVERLESS/POD), and `repoOwner` filters (applied client-side), and an opt-in `includeConfig` that returns the release's parsed hardware/env-var config from `.runpod/hub.json`. Results are sorted most-deployed first and use the shared pagination envelope.
- e4fabd1: Add a `list-public-endpoints` tool for discovering Runpod Public Endpoints — the managed, pay-per-use model APIs (text, image, video, audio) that require no deployment. Served by the public GraphQL endpoint — no auth required — and available on both v1 and v2. Each result includes the `endpointId` to call with `run-endpoint`/`runsync-endpoint` (or directly at `https://api.runpod.ai/v2/{endpointId}`), plus the model name, modality, owner, and pricing parsed from the catalog metadata. Only live endpoints are listed by default (`includeOffline:true` to include the rest), with `searchTerm`, `modality`, and `owner` filters and the shared pagination envelope.
- cc0966c: Enable pod and serverless worker log streaming (v2). `stream-pod-logs` (GET /v2/pods/{id}/logs) is now registered — it was previously implemented but disabled while the endpoint was dev-only, and it is now live on prod. A new `stream-worker-logs` tool (GET /v2/serverless/{id}/workers/{workerId}/logs) streams a single worker's logs; get the workerId from `list-endpoint-workers`. Both read a bounded snapshot of the Server-Sent-Events stream (container and/or system) and support `source`, `tail`, `since`, and `maxWaitMs`; both return a 501 notice on the v1 API.
- 466a9d8: Add a `set-endpoint-gpus` tool that sets which GPUs any Serverless endpoint's workers run on — including pinning specific GPU SKUs, which the REST API cannot express (its pool-level `gpuPoolIds` has no exclusion concept). Callers pass either a raw `gpuIds` string or `pools` plus `excludeGpuTypeIds` (GPU type ids from `list-gpu-types`) and the exclusion string is built automatically; excluding all but one SKU in a pool pins that SKU exactly. Because the GraphQL `saveEndpoint` mutation resets omitted endpoint-level fields to server defaults (verified live), the tool reads the endpoint's current settings first and echoes every field back with only the GPU selection changed — workers, scaling, timeouts, FlashBoot, locations, network volumes, and the template are all preserved.
- d1f3719: create-pod template deploy improvements. Added a `containerRegistryAuthId` param to `create-pod` (private-image registry credential, a valid v2 ContainerConfig field). When deploying from a `templateId`, the template's registry credential is inherited as a default so a private-image template pulls correctly, `containerRegistryAuthId` overrides it, and passing an empty string opts out entirely (emits `registry: null`, which v2 accepts, clearing the template's credential). The template is fetched from v2 explicitly, so a split per-resource version override (e.g. templates pinned to v1) can't yield a v1-shaped template merged into a v2 pod body. Tool descriptions now state that template fields are applied whole-field as defaults (an explicitly-passed field replaces the template value rather than merging).
- 0b49b91: Fix two template gaps from the same ticket (API-385 / E-3717).
  1. `create-template`/`update-template` were dropping the container start command on the v2 REST API. `dockerStartCmd` is now mapped to the v2 template's `args` field (a single string; a multi-element array is space-joined) instead of being discarded, so a template's startup command is persisted. `update-template` accepts `dockerStartCmd` now too. (v2 has no separate entrypoint field, so `dockerEntrypoint` is still not persisted on v2 — documented in the tool.)
  2. `create-pod` can now deploy from a template. v2 `CreatePodRequest` has no `templateId`, so `create-pod` accepts a `templateId`, fetches the template, and spreads its container config (image, start command, ports, env, disk, volume, registry credential) into the pod body as defaults — any field you also pass explicitly overrides the template. `imageName` is now optional when `templateId` is given. Template-based deploy requires the v2 REST API and (for now) a GPU pod; clear errors are returned for v1, CPU, or when neither image nor template is supplied.

### Patch Changes

- e50409d: URL-encode the resource ids interpolated into the log-streaming request paths (`stream-pod-logs`, `stream-worker-logs`) so an id containing a URL-special character can't corrupt the request path. Opaque Runpod ids are unaffected in practice; this is defensive hardening.
- fb76883: Surface the configured `RUNPOD_REST_VERSION` in the MCP `serverInfo` version, e.g. `2.0.0 [RUNPOD_REST_VERSION=v2]` (or `RUNPOD_REST_VERSION unset (default v2)`). A plain `initialize` handshake now reveals whether a deployment is running v1 or v2 without inspecting the environment, and flags any per-resource overrides.

## 2.0.0

### Major Changes

- 2658e43: **Breaking:** default the REST version to **v2**, and migrate Serverless
  endpoint CRUD to the v2 API.

  With nothing set, all control-plane resources now use the v2 REST API
  (`v2-rest.runpod.io/v2`); set `RUNPOD_REST_VERSION=v1` to pin the previous v1
  behavior.

  Why this is a major bump: `create-endpoint`/`update-endpoint` move from the v1
  **template-based** model to the v2 **inline-config** model. On v2,
  `create-endpoint` no longer accepts a `templateId` — it requires `imageName` +
  `gpuPoolIds` (GPU pool names from `list-gpu-types`, e.g. `AMPERE_80`) plus
  optional `workers`/`scaling`. So an existing integration that calls
  `create-endpoint` with `{ templateId }` and no `RUNPOD_REST_VERSION` pin will
  get a clean `400` after upgrading, with no code change on their side. To keep
  the old behavior, pin `RUNPOD_REST_VERSION=v1` (templateId model preserved).

  `jobs` still resolves to v1 (serverless runtime API, no v2 home). CPU pods are
  still served by v1, and the `auto` stdio probe is unchanged. Version-sensitive
  tests pin their version explicitly so the suite is independent of the default.

  See the README "REST API version (v1 / v2)" section for the migration note.

### Minor Changes

- cdba19c: Add v2-only tools covering the rest of the v2 REST surface:
  - **Tags** — `list-tags`, `get-tag`, `create-tag`, `update-tag`, `delete-tag`,
    and `attach-tag` / `detach-tag` to associate a tag with a pod, network volume,
    cluster, or serverless endpoint.
  - **Billing** — `get-billing` returns time-bucketed spend, either aggregated or
    broken down by resource type (`scope`), windowed by `startTime`/`endTime` or
    `lastN`. The records array is capped via `limit`/`cursor`.
  - **Endpoint workers** — `list-endpoint-workers` lists the workers behind a
    serverless endpoint plus an aggregate summary (capped via `limit`/`cursor`).
  - **Catalog by id** — `get-cpu-type` and `get-data-center` round out the catalog
    alongside the existing `get-gpu-type`.

  These resources exist only on the v2 REST API, so each returns a clean `501`
  notice on v1 (set `RUNPOD_REST_VERSION=v2`).

## 1.4.0

### Minor Changes

- f3ddd6d: Cap list-tool responses so they no longer overflow the agent's context window.
  Every `list-*` tool (`list-pods`, `list-endpoints`, `list-templates`,
  `list-network-volumes`, `list-container-registry-auths`) now accepts optional
  `limit` and `cursor` parameters and returns at most `limit` items (default 20,
  max 100) inside a `{ items, pagination }` envelope that reports `total`,
  `returned`, `truncated`, and a `nextCursor` for fetching the next page.

  The REST API does not yet support server-side pagination, so this is a
  client-side cap; the `limit`/`cursor` signature is shaped to match the
  cursor-based pagination the REST API will add, so the tool interface will not
  change when server-side pagination lands.

- e59fbfe: Add a guided install wizard. Running `npx @runpod/mcp-server@latest add` detects installed agents (Claude Code, Claude Desktop, Cursor, Windsurf, Visual Studio Code), lets you pick which to configure, and writes the MCP configuration for each. It offers two connection modes: a hosted mode that points the agent at the hosted server and authenticates with the "Sign in with Runpod" OAuth flow (no API key stored on disk), and a local mode that runs the server via npx with a `RUNPOD_API_KEY`. `remove` undoes the changes. Existing config files keep their formatting and comments.

## 1.3.0

### Minor Changes

- 3e6dedf: Add HTTP transport for hosted MCP server deployments. The package now exports three entrypoints: `@runpod/mcp-server` (stdio, unchanged), `@runpod/mcp-server/http` (streamable HTTP with per-request auth), and `@runpod/mcp-server/tools` (shared tool definitions). This enables deploying the MCP server on Vercel or any HTTP-capable host where each request carries its own Runpod API key via the Authorization header. Existing stdio users are unaffected.
- 3e6dedf: Add a "Sign in with Runpod" OAuth flow to the hosted HTTP server so it can act as the authorization server for Claude's MCP connector. When `MCP_OAUTH_ENABLED=true`, the server advertises itself in the OAuth discovery metadata and exposes `GET /authorize` and `POST /token`. The flow reuses the Runpod flash auth backend: `/authorize` creates a guest `createFlashAuthRequest` and hands off to the Runpod console for approval, and `/token` polls `flashAuthRequestStatus` and returns the minted Runpod API key as the access token, which the server then forwards to the Runpod API. The backend endpoint and console base URL are configurable via `RUNPOD_GRAPHQL_URL` and `CONSOLE_BASE_URL`.
- 3e6dedf: Complete the hosted OAuth flow for real MCP clients. Add an OAuth 2.0 Dynamic Client Registration endpoint (`POST /register`, RFC 7591) and advertise it as `registration_endpoint`, so clients like Claude can register before signing in. Make the Runpod REST and Serverless API hosts configurable via `RUNPOD_REST_API_URL` and `RUNPOD_SERVERLESS_API_URL` so a deployment authenticating with non-production keys can target the matching environment. The console handoff path is `/integrations/mcp/login`.
- 3e6dedf: Validate the OAuth `redirect_uri` against an allowlist. Because the authorization code redeems into a real Runpod API key, `/authorize` and `/token` now reject any `redirect_uri` that is not an allowlisted client callback, preventing an attacker from crafting an authorize link that delivers the code (and key) to a host they control. Loopback addresses (`http://localhost` / `127.0.0.1` / `::1`, any port) are always allowed per RFC 8252; the hosted client callbacks default to Claude's, and the list is extendable via `MCP_ALLOWED_REDIRECT_URIS` (comma-separated).
- 3e6dedf: Address hosted OAuth review feedback:
  - Remove the `MCP_OAUTH_ENABLED` flag — the hosted HTTP server always advertises the OAuth sign-in challenge. Callers that bring their own Runpod API key as the bearer token are unaffected (they never hit the challenge).
  - Default `CONSOLE_BASE_URL` to the production console (`https://console.runpod.io`) so a deploy that forgets to set it doesn't silently redirect users to localhost.
  - `/token` now polls for most of the function budget (~45s) instead of returning a non-retryable `authorization_pending` after ~10s, avoiding a dead-end when console→backend approval propagation lags.
  - Caller-tracking falls back to the inbound HTTP `User-Agent` on the stateless HTTP transport, where the per-request server never sees the MCP `initialize` `clientInfo` (previously reported `client=unknown`).
  - Stop advertising PKCE (`S256`) since it isn't enforced server-side; security rests on the `redirect_uri` allowlist and the single-use flash approval.
  - Default the minted key name to `runpod-mcp` (`RUNPOD_API_KEY_NAME`), so hosted keys are identifiable/revocable. Set `RUNPOD_API_KEY_NAME=""` to suppress it for a backend that has not shipped the `apiKeyName` argument.

- 3e6dedf: Simplify hosted HTTP auth to pure token passthrough. The server now forwards the caller's Bearer token directly to the Runpod API and holds no credential of its own — there is no shared server-side key and no token translation. When `MCP_OAUTH_ENABLED=true`, unauthenticated requests return a `WWW-Authenticate` challenge so OAuth-capable clients start the "Sign in with Runpod" flow. Removes the `RUNPOD_HTTP_SHARED_API_KEY` environment variable and the `jose` dependency.

### Patch Changes

- 3e6dedf: Support naming the minted Runpod API key in the OAuth flow. Set `RUNPOD_API_KEY_NAME` (e.g. `runpod-mcp`) to pass `apiKeyName` through to the flash backend's `createFlashAuthRequest`, so the key shows up under that name in the user's dashboard. It is omitted by default for compatibility with backends that don't yet support the argument.
- 3e6dedf: Address low-severity review nits on the hosted HTTP / OAuth path:
  - Make the public discovery GraphQL host configurable via `RUNPOD_PUBLIC_GRAPHQL_URL` (was hardcoded to prod, so a dev deploy hit prod GraphQL).
  - Report the real package version in the hosted server's outbound `User-Agent` (read from package.json at runtime, since tsup's build-time define doesn't run when Vercel compiles `api/index.ts`).
  - Gate OAuth request-id / handoff-URL logging behind `MCP_VERBOSE_LOGS` (request ids are live, single-use auth codes).
  - `stream-job` now surfaces the most recent polling error in its timeout payload instead of discarding it.
  - Pass the parsed request body to the MCP transport explicitly; dispose the per-request server/transport on response close; guard `getBaseUrl` against a missing `Host`; handle a `Buffer` request body in the token endpoint.
  - Single CORS source of truth (handler, not `vercel.json`); stop serving the whole repo as static assets; add an `oauth-e2e` npm script and `engines.pnpm`; fix docs that misattributed the OAuth routes and listed the new env vars.

## 1.2.0

### Minor Changes

- 7b715eb: Add list-gpu-types and list-data-centers tools using public GraphQL API for hardware and region discovery. Enhance list-templates with filter params (includeRunpodTemplates, includePublicTemplates, includeEndpointBoundTemplates). Add tool descriptions to create-pod and list-templates recommending Pytorch 2.8.0 as default template.
- ea2451b: Add Serverless endpoint runtime tools for invoking deployed workers. New tools: run-endpoint (async), runsync-endpoint (sync), get-job-status, stream-job, cancel-job, retry-job, endpoint-health, and purge-endpoint-queue. These use the Serverless API at api.runpod.ai/v2 with a new serverlessRequest helper.
- 34c0463: Add caller tracking headers to every outbound API call. Each request now carries a structured `User-Agent` (`runpod-mcp-server/<version> (caller=mcp; client=<mcp_client_name>; client_version=<mcp_client_version>; transport=<stdio|http>)`) and an anonymous per-process `X-Runpod-Session-Id` UUID. The MCP client identity is sourced from the `initialize` handshake's `clientInfo`. No tool behavior changes — observability only — so the Runpod platform can attribute traffic to specific MCP clients (Claude Code, Cursor, Codex, Gemini CLI, etc.) and count distinct agent sessions.

## 1.1.0

### Minor Changes

- c49b2cc: Add npx support for running the MCP server directly without installation. Includes bin field in package.json, shebang in build output, and updated README with npx command. Also fixes branding consistency (Runpod -> Runpod) and adds development conventions documentation.
