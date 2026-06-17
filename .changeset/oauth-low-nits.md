---
"@runpod/mcp-server": patch
---

Address low-severity review nits on the hosted HTTP / OAuth path:

- Make the public discovery GraphQL host configurable via `RUNPOD_PUBLIC_GRAPHQL_URL` (was hardcoded to prod, so a dev deploy hit prod GraphQL).
- Report the real package version in the hosted server's outbound `User-Agent` (read from package.json at runtime, since tsup's build-time define doesn't run when Vercel compiles `api/index.ts`).
- Gate OAuth request-id / handoff-URL logging behind `MCP_VERBOSE_LOGS` (request ids are live, single-use auth codes).
- `stream-job` now surfaces the most recent polling error in its timeout payload instead of discarding it.
- Pass the parsed request body to the MCP transport explicitly; dispose the per-request server/transport on response close; guard `getBaseUrl` against a missing `Host`; handle a `Buffer` request body in the token endpoint.
- Single CORS source of truth (handler, not `vercel.json`); stop serving the whole repo as static assets; add an `oauth-e2e` npm script and `engines.pnpm`; fix docs that misattributed the OAuth routes and listed the new env vars.
