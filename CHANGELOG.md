# @runpod/mcp-server

## 1.3.0

### Minor Changes

- 3e6dedf: Add HTTP transport for hosted MCP server deployments. The package now exports three entrypoints: `@runpod/mcp-server` (stdio, unchanged), `@runpod/mcp-server/http` (streamable HTTP with per-request auth), and `@runpod/mcp-server/tools` (shared tool definitions). This enables deploying the MCP server on Vercel or any HTTP-capable host where each request carries its own RunPod API key via the Authorization header. Existing stdio users are unaffected.
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

- c49b2cc: Add npx support for running the MCP server directly without installation. Includes bin field in package.json, shebang in build output, and updated README with npx command. Also fixes branding consistency (RunPod -> Runpod) and adds development conventions documentation.
