# Runpod MCP server

[![smithery badge](https://smithery.ai/badge/@runpod/runpod-mcp-ts)](https://smithery.ai/server/@runpod/runpod-mcp-ts)

This is the official Runpod Model Context Protocol (MCP) server, published to npm as `@runpod/mcp-server`. It lets MCP clients such as Claude Code, Claude Desktop, Cursor, Windsurf, and VS Code manage your Runpod Pods, Serverless endpoints, templates, network volumes, and more.

## Quick start

The fastest way to get connected is the guided installer pointed at the **hosted Runpod MCP server at `https://mcp.getrunpod.io/`**. The installer detects the agents you have installed, asks which ones to configure, and writes the configuration for you:

```bash
npx @runpod/mcp-server@latest add
```

It supports **Claude Code, Claude Desktop, Cursor, Windsurf, and Visual Studio Code**, and offers two connection modes:

- **Hosted (recommended).** Points the agent at the hosted server and authenticates with the **"Sign in with Runpod"** OAuth flow, so **no API key is stored on disk**.
- **Local.** Runs the server through `npx` and stores a `RUNPOD_API_KEY` in the agent's config.

To undo the changes later, run:

```bash
npx @runpod/mcp-server@latest remove
```

### Connect to the hosted server manually

If you'd rather configure your client by hand, point it at the hosted server over HTTP (no local process, no API key stored).

**Claude Code** — add it as an HTTP server:

```bash
claude mcp add --transport http runpod -s user https://mcp.getrunpod.io/
```

**Other clients** (Cursor, VS Code, Claude Desktop connectors, …) — use a URL-based MCP entry:

```json
{
  "mcpServers": {
    "runpod": {
      "url": "https://mcp.getrunpod.io/"
    }
  }
}
```

The hosted server uses the "Sign in with Runpod" OAuth flow for authentication, so no API key is stored. An OAuth-capable client starts the sign-in flow automatically on first connect. See [Sign in with Runpod (authorize flow)](#sign-in-with-runpod-authorize-flow) for details.

> Prefer your own API key instead of OAuth? Append `--header "Authorization: Bearer YOUR_API_KEY"` to the `claude mcp add` command (or add a `headers` block in the JSON), and the server forwards that key to the Runpod API directly.

### Requirements

- Node.js 18 or higher.
- A Runpod account and API key: https://www.runpod.io/console/user/settings

## Run locally with `npx`

To run the server as a local `stdio` process with your own API key:

```bash
RUNPOD_API_KEY=YOUR_API_KEY npx -y @runpod/mcp-server@latest
```

### Install via Smithery

```bash
npx -y @smithery/cli install @runpod/runpod-mcp-ts --client claude
```

## Local MCP client setup

Local MCP clients should use the default package entrypoint, which is the `stdio` server. The caller sets `RUNPOD_API_KEY` in the environment, and the server forwards it directly to the Runpod API.

### Claude Code

```bash
claude mcp add runpod -s user \
  -e RUNPOD_API_KEY=YOUR_API_KEY \
  -- npx -y @runpod/mcp-server@latest
```

For a project-local server:

```bash
claude mcp add runpod -s project \
  -e RUNPOD_API_KEY=YOUR_API_KEY \
  -- npx -y @runpod/mcp-server@latest
```

Verify with `claude mcp list`. In an active session, use `/mcp` to reconnect.

### Claude Desktop

Local MCP servers in Claude Desktop still use `claude_desktop_config.json`.

macOS:

`~/Library/Application Support/Claude/claude_desktop_config.json`

Windows:

`%APPDATA%\\Claude\\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "runpod": {
      "command": "npx",
      "args": ["-y", "@runpod/mcp-server@latest"],
      "env": {
        "RUNPOD_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

For remote clients such as Claude's connector, use the hosted HTTP server instead (the [Quick start](#quick-start) above). The client then runs the OAuth "Sign in with Runpod" flow, and the resulting Runpod API key is forwarded to the Runpod API on each request.

### Cursor

Add this to `.cursor/mcp.json` in your project or `~/.cursor/mcp.json` globally:

```json
{
  "mcpServers": {
    "runpod": {
      "command": "npx",
      "args": ["-y", "@runpod/mcp-server@latest"],
      "env": {
        "RUNPOD_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### VS Code, Windsurf, Cline, JetBrains, and other local clients

Use the same pattern:

- command: `npx`
- args: `["-y", "@runpod/mcp-server@latest"]`
- env: `RUNPOD_API_KEY=YOUR_API_KEY`

For a broader list of MCP clients, see https://modelcontextprotocol.io/clients

## Usage examples

### List all Pods

```text
Can you list all my Runpod Pods?
```

### Create a new Pod

```text
Create a new Runpod Pod with the following specifications:
- Name: test-pod
- Image: runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04
- GPU Type: NVIDIA GeForce RTX 4090
- GPU Count: 1
```

### Create a Serverless endpoint

```text
Create a Runpod Serverless endpoint with the following configuration:
- Name: my-endpoint
- Image: runpod/test-output:0.0.1
- GPU pool: AMPERE_80   (a "pool" value from list-gpu-types)
- Minimum workers: 0
- Maximum workers: 3
```

On the v2 API (the default) endpoints are image-based — pass an image and a GPU
pool, not a template. To use the legacy template-based model, pin
`RUNPOD_REST_VERSION=v1` and provide a `Template ID` instead.

## Hosted HTTP deployment

The package also exports a Streamable HTTP entrypoint at `@runpod/mcp-server/http`, and this repo includes a Vercel function in `api/index.ts`. This is what powers the hosted server at `https://mcp.getrunpod.io/`.

The hosted transport is stateless:

- Each request creates a fresh MCP server instance.
- The caller must send `Authorization: Bearer <token>`.
- No credentials are cached or shared server-side.

### Hosted auth

The server forwards the caller's Bearer token directly to the Runpod API as the credential for that request. There is no server-side or shared key.

The token can be either:

- a Runpod API key the caller configured manually, or
- a Runpod API key obtained through the OAuth "Sign in with Runpod" flow (see below).

An unauthenticated request receives a `401` with a `WWW-Authenticate` header pointing at the protected-resource metadata, which tells an OAuth-capable client (such as Claude) to start the sign-in flow. A caller that brings its own API key as the bearer token never hits that path.

### Sign in with Runpod (authorize flow)

In OAuth mode the hosted server is itself the authorization server for Claude's connector. It advertises itself in `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, pointing `authorization_endpoint` at its own `GET /authorize`, `token_endpoint` at its own `POST /token`, and `registration_endpoint` at its own `POST /register`.

The flow reuses the Runpod flash auth backend and mints a real Runpod API key:

1. The client registers via `POST /register` (OAuth Dynamic Client Registration, RFC 7591) to obtain a `client_id`. This is a public client; no client secret is used.
2. `GET /authorize` calls the guest `createFlashAuthRequest` mutation to get a request id (which serves as the OAuth authorization code), then `302`-redirects the browser to the console handoff page (`/integrations/mcp/login`), carrying the request id plus the client's `redirect_uri` and `state`.
3. The user logs in and approves the request in the console. On approval the backend mints a Runpod API key for the request.
4. The console returns the browser to the client's `redirect_uri` with `code=<request id>`.
5. `POST /token` polls the guest `flashAuthRequestStatus` query for that id; once `APPROVED`, it returns the minted `apiKey` as the `access_token`. The client then sends that key as its bearer token on every MCP request, and the server forwards it to the Runpod API.

This flow uses these environment variables:

- `RUNPOD_GRAPHQL_URL`: flash auth backend endpoint (default `https://api.runpod.io/graphql`).
- `CONSOLE_BASE_URL`: base URL of the console that hosts the handoff login page (default `https://console.runpod.io`).
- `RUNPOD_REST_API_URL` / `RUNPOD_SERVERLESS_API_URL`: override the REST and Serverless API hosts so a deployment authenticating with non-production keys can target the matching environment.
- `RUNPOD_API_KEY_NAME`: name for the minted key as shown in the user's dashboard. Defaults to `runpod-mcp`. Set it to `""` to omit the name for a backend that does not support the `apiKeyName` argument (such backends reject the request when it is sent).
- `MCP_ALLOWED_REDIRECT_URIS`: comma-separated extra `redirect_uri` values to allow, in addition to the built-in Claude callbacks. Loopback addresses (`localhost`/`127.0.0.1`/`::1`, any port) are always allowed. `/authorize` and `/token` reject any `redirect_uri` not on this list, since the authorization code redeems into a real API key.

You can verify the entire flow end to end with `MCP_SERVER_URL=<deployment-url> npx tsx scripts/oauth-e2e.ts` (the harness uses a loopback callback).

Notes and current limitations:

- PKCE is not supported: `code_challenge` is neither advertised nor enforced (the flash flow has no place to bind it). Security relies on the `redirect_uri` allowlist and the single-use, short-lived flash approval.
- The minted key is named via `RUNPOD_API_KEY_NAME` (default `runpod-mcp`), which requires a flash backend that supports the `apiKeyName` argument. Against a backend without it, set `RUNPOD_API_KEY_NAME=""`.

### Vercel

This repo already contains `vercel.json` and the Vercel handler.

Deploy with the Vercel CLI:

```bash
vercel
vercel --prod
```

After deploy, test the endpoint:

```bash
curl -i https://YOUR-DEPLOYMENT.vercel.app/
```

Unauthenticated requests should return `401`.

### Hosted smoke test

```bash
MCP_SERVER_URL=https://YOUR-DEPLOYMENT.vercel.app \
RUNPOD_API_KEY=YOUR_API_KEY \
pnpm smoke:http
```

This validates:

- MCP initialization.
- `tools/list`.
- A public GraphQL-backed tool call.
- An authenticated REST-backed tool call.

## Local development

```bash
git clone https://github.com/runpod/runpod-mcp.git
cd runpod-mcp
pnpm install
pnpm build
```

Run the local build directly:

```bash
RUNPOD_API_KEY=YOUR_API_KEY node dist/stdio.mjs
```

Or point a client at your local build:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/runpod-mcp/dist/stdio.mjs"],
  "env": {
    "RUNPOD_API_KEY": "YOUR_API_KEY"
  }
}
```

### Local smoke test

```bash
RUNPOD_API_KEY=YOUR_API_KEY pnpm build
RUNPOD_API_KEY=YOUR_API_KEY pnpm smoke:stdio
```

## Contributing

The source is now split by responsibility:

- `src/stdio.ts`: local `stdio` entrypoint (runs the v2 probe at startup for `auto` mode).
- `src/http.ts`: bearer-token extraction and the per-request MCP session for the Streamable HTTP transport.
- `src/tools.ts`: thin orchestrator — builds the shared runtime and calls each per-resource registrar.
- `src/tools/<resource>.ts`: the tools for one resource (`pods`, `endpoints`, `jobs`, `templates`, `network-volumes`, `registries`, `catalog`), each with a description + MCP annotations.
- `src/tools/runtime.ts`: the shared per-server runtime (caller-tracking, the authenticated REST/Serverless/GraphQL clients, the v1/v2 backend resolver) threaded into every registrar.
- `src/server.ts`: shared server metadata and construction.
- `src/_shared/backend.ts`: v1/v2 routing adapter — version resolution, per-resource paths, list-envelope unwrap, and the v2 probe.
- `src/_shared/http.ts`: unified authenticated JSON client + `HttpError`.
- `src/_shared/tracking.ts`: caller-tracking header construction.
- `src/_shared/mappers.ts`: v1→v2 request-body mappers.
- `api/index.ts`: Vercel adapter and the OAuth authorization-server routes (`/.well-known/*`, `/register`, `/authorize`, `/token`).

After changes:

```bash
pnpm type-check
pnpm lint
pnpm test
pnpm build
```

`pnpm test` runs the offline unit suite (outbound-request goldens, adapter, mappers, http client) — no network or API key required.

### v2 spec parity gate

`tests/spec-parity.test.ts` walks every operation in the vendored v2 OpenAPI spec (`tests/fixtures/v2-openapi.yaml`) and fails if a v2 endpoint has no MCP tool covering it (and isn't explicitly allowlisted) — the drift gate that flags when the API grows an endpoint we don't expose yet. It also runs the reverse check (no tool is left unaccounted for). It's part of `pnpm test`, hermetic (parses the committed spec; no network, no API key).

Refresh the vendored spec when the v2 API changes:

```bash
pnpm tsx scripts/fetch-v2-spec.ts   # re-fetch tests/fixtures/v2-openapi.yaml
pnpm test                           # parity test shows any newly-uncovered endpoint
```

The serverless runtime tools (`run-endpoint`, `get-job-status`, …) target `api.runpod.ai/v2`, which is a different service from the v2 REST control plane, so they are allowlisted as intentionally spec-unmapped. The spec has no logs/artifacts endpoints, so there are no such tools.

An optional live shape check (skipped by default) verifies the live endpoints still return the envelopes the list tools unwrap; run it with `MCP_LIVE_V2_KEY=<dev-key> pnpm test` (optionally `MCP_LIVE_V2_BASE`).

For transport validation:

```bash
pnpm smoke:stdio
pnpm smoke:http
```

To exercise a real create→get→delete lifecycle against a **dev account** (free resources only — templates and registry auths — with fail-closed teardown):

```bash
RUNPOD_API_KEY=YOUR_DEV_KEY \
RUNPOD_REST_V2_API_URL=https://v2-rest.runpod.dev/v2 \
pnpm smoke:crud v1 v2
```

This project uses [changesets](https://github.com/changesets/changesets) for versioning and npm publishing. Every PR with user-facing changes needs a changeset file at `.changeset/DESCRIPTIVE_NAME.md`.

See `CLAUDE.md` and `docs/context.md` for contributor guidance.

## Reference

### Deployment modes

The server supports two deployment modes:

- Local `stdio` for Claude Desktop, Claude Code, Cursor, VS Code, and other MCP clients that launch a local process. The caller sets `RUNPOD_API_KEY` in the environment.
- Hosted Streamable HTTP for Vercel or other HTTP-capable platforms. Each request carries its own `Authorization: Bearer <token>`, which the server forwards directly to the Runpod API. The token can be a Runpod API key or one obtained through the OAuth "Sign in with Runpod" flow.

The server never holds a credential of its own and never shares one across users.

### REST API version (v1 / v2)

The server can target either the v1 REST API (`rest.runpod.io/v1`) or the newer v2 REST API (`v2-rest.runpod.io/v2`). It **defaults to v2**; set `RUNPOD_REST_VERSION=v1` to pin the previous v1 behavior. These environment variables are read once at startup:

| Variable                         | Values                 | Default                        | Effect                                                                                                |
| -------------------------------- | ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `RUNPOD_REST_VERSION`            | `v1` \| `v2` \| `auto` | `v2`                           | Version used for all resources.                                                                       |
| `RUNPOD_REST_VERSION_<RESOURCE>` | `v1` \| `v2` \| `auto` | —                              | Per-resource override (e.g. `RUNPOD_REST_VERSION_PODS=v2`). Takes precedence over the global setting. |
| `RUNPOD_REST_V2_API_URL`         | URL                    | `https://v2-rest.runpod.io/v2` | v2 base URL. Override to target a non-prod host.                                                      |
| `RUNPOD_REST_API_URL`            | URL                    | `https://rest.runpod.io/v1`    | v1 base URL.                                                                                          |
| `RUNPOD_SERVERLESS_API_URL`      | URL                    | `https://api.runpod.ai/v2`     | Serverless runtime base URL.                                                                          |

Notes:

- **Default is v2** — with nothing set, every control-plane resource uses the v2 REST API. Set `RUNPOD_REST_VERSION=v1` to pin the previous v1 behavior.
- **Pinning a deployment** — the env var is read once at startup, so set `RUNPOD_REST_VERSION` (`v1` or `v2`) in the host's environment (e.g. a Vercel project env var) and redeploy; no code change. Hosted HTTP honors this default like any other transport.
- **What `auto` does:** it probes v2 once at startup and falls back to v1 — but **only on the `stdio` transport** (one process = one key). On hosted HTTP `auto` resolves to **v1**, because a warm instance serves many users and a cached probe verdict could leak across them. `auto` is a stdio-only convenience; on HTTP, rely on the default or pin the version explicitly.
- `jobs` (serverless runtime) always uses v1 regardless of the setting — it has no v2 REST home (it targets `api.runpod.ai/v2`, a different service).
- The v2-only tools (`list-cpu-types`, `get-gpu-type`, `restart-pod`) return a clear "v2 only" notice when called under v1.

> **⚠️ Migration note — `create-endpoint` / `update-endpoint` changed shape in v2.** Serverless endpoints now use the v2 API (`/v2/serverless`) with an **inline config** instead of a `templateId`. On v2, `create-endpoint` requires `imageName` + `gpuPoolIds` (GPU **pool** names from `list-gpu-types` — the `pool` field, e.g. `AMPERE_80`), plus optional `workersMin`/`workersMax`, `scalerType`/`scalerValue`/`idleTimeout`, `containerDiskInGb`, `env`, `flashboot`, etc. It no longer accepts `templateId`. **If you previously called `create-endpoint` with `{ templateId }` and have no `RUNPOD_REST_VERSION` set, that call now returns a clean `400` after upgrading** — switch to the inline fields, or pin `RUNPOD_REST_VERSION=v1` to keep the legacy template-based model.

- `create-pod` for a **CPU pod** (`computeType: "CPU"`) on v2 is transparently served by the **v1** API — v2 has no CPU pods yet — and the reply is flagged `_servedBy: "v1"`. Because that fallback hits the **v1 base**, set `RUNPOD_REST_API_URL` to match your environment when running v2 against a non-prod host (otherwise CPU creates land on v1 **prod**). On v2 a create with neither `gpuTypeIds` nor `computeType` is rejected — absence is never silently turned into a CPU pod.

Example (stdio client config) — v2 against prod:

```json
"env": {
  "RUNPOD_API_KEY": "YOUR_API_KEY",
  "RUNPOD_REST_VERSION": "v2"
}
```

Targeting a **non-prod (dev) environment** — point **both** bases at it (the v1 base matters even in v2 mode, for the CPU-pod fallback above):

```json
"env": {
  "RUNPOD_API_KEY": "YOUR_DEV_KEY",
  "RUNPOD_REST_VERSION": "v2",
  "RUNPOD_REST_V2_API_URL": "https://v2-rest.runpod.dev/v2",
  "RUNPOD_REST_API_URL": "https://rest.runpod.dev/v1"
}
```

### Large tool output

Resource **lists** are paginated (default 20 items, `nextCursor`), so a big account can't flood the agent's context. But **serverless job output** — `run-endpoint`, `runsync-endpoint`, `get-job-status`, and especially `stream-job` (which accumulates every chunk) — is returned **as-is and is not size-capped**. It's a single opaque payload, not a list, so there's no cursor to page. A very large or long-streaming result can exceed the context window. If output may be huge, have the agent **write it to a file** instead of returning it inline, or set `s3Config` on the job so large outputs go to object storage.

## Security considerations

This server acts with the full permissions of the supplied `RUNPOD_API_KEY`.

- Never share your API key.
- Be deliberate about destructive tools.
- Treat hosted deployments as sensitive infrastructure.
- Each request authenticates with its own caller-supplied token, which is forwarded to the Runpod API and never persisted server-side.

## License

Apache-2.0
