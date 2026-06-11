# Runpod MCP server

[![smithery badge](https://smithery.ai/badge/@runpod/runpod-mcp-ts)](https://smithery.ai/server/@runpod/runpod-mcp-ts)

This is the official Runpod Model Context Protocol (MCP) server, published to npm as `@runpod/mcp-server`.

It supports two deployment modes:

- Local `stdio` for Claude Desktop, Claude Code, Cursor, VS Code, and other MCP clients that launch a local process. The caller sets `RUNPOD_API_KEY` in the environment.
- Hosted Streamable HTTP for Vercel or other HTTP-capable platforms. Each request carries its own `Authorization: Bearer <token>`, which the server forwards directly to the Runpod API. The token can be a Runpod API key or one obtained through the OAuth "Sign in with Runpod" flow.

The server never holds a credential of its own and never shares one across users.

## Requirements

- Node.js 18 or higher.
- A Runpod account and API key: https://www.runpod.io/console/user/settings

## Quick start

### Run locally with `npx`

```bash
RUNPOD_API_KEY=YOUR_API_KEY npx -y @runpod/mcp-server@latest
```

### Install via Smithery

```bash
npx -y @smithery/cli install @runpod/runpod-mcp-ts --client claude
```

## Local MCP clients

Local MCP clients should use the default package entrypoint, which is the `stdio` server.

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

## Hosted HTTP deployment

The package also exports a Streamable HTTP entrypoint at `@runpod/mcp-server/http`, and this repo includes a Vercel function in `api/index.ts`.

The hosted transport is stateless:

- Each request creates a fresh MCP server instance.
- The caller must send `Authorization: Bearer <token>`.
- No credentials are cached or shared server-side.

### Hosted auth

The server forwards the caller's Bearer token directly to the Runpod API as the credential for that request. There is no server-side or shared key.

The token can be either:

- a Runpod API key the caller configured manually, or
- a Runpod API key obtained through the OAuth "Sign in with Runpod" flow (see below), which is advertised when `MCP_OAUTH_ENABLED=true`.

When `MCP_OAUTH_ENABLED=true`, an unauthenticated request receives a `401` with a `WWW-Authenticate` header pointing at the protected-resource metadata, which is what tells an OAuth-capable client (such as Claude) to start the sign-in flow.

### Sign in with Runpod (authorize flow)

In OAuth mode the hosted server is itself the authorization server for Claude's connector. It advertises itself in `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, pointing `authorization_endpoint` at its own `GET /authorize` and `token_endpoint` at its own `POST /token`.

The flow reuses the Runpod flash auth backend and mints a real Runpod API key:

1. `GET /authorize` calls the guest `createFlashAuthRequest` mutation to get a request id (which serves as the OAuth authorization code), then `302`-redirects the browser to the Runpod console handoff page, carrying the request id plus Claude's `redirect_uri` and `state`.
2. The user logs in and approves the request in the console. On approval the backend mints a Runpod API key for the request.
3. The console returns the browser to Claude's `redirect_uri` with `code=<request id>`.
4. `POST /token` polls the guest `flashAuthRequestStatus` query for that id; once `APPROVED`, it returns the minted `apiKey` as the `access_token`. Claude then sends that key as its bearer token on every MCP request, and the server forwards it to the Runpod API.

This flow uses these environment variables:

- `MCP_OAUTH_ENABLED`: set to `true` to advertise the OAuth sign-in flow.
- `RUNPOD_GRAPHQL_URL`: flash auth backend endpoint (default `https://timpietrusky-api.runpod.dev/graphql`).
- `CONSOLE_BASE_URL`: base URL of the console that hosts the handoff login page (default `http://localhost:3000`).

Notes and current limitations:

- PKCE (`code_challenge`) is advertised but not enforced server-side; security relies on the single-use, short-lived flash request and the console approval step.
- The minted key currently shows up named `flash-cli` in the user's Runpod dashboard (hardcoded in the backend). Renaming it to something like `claude-mcp` requires a Runpod backend change; it is not configurable through the API.

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

## Claude Desktop and hosted MCP

Use the local `stdio` integration for Claude Desktop today.

For remote clients such as Claude's connector, deploy the hosted HTTP server with `MCP_OAUTH_ENABLED=true`. The client then runs the OAuth "Sign in with Runpod" flow, and the resulting Runpod API key is forwarded to the Runpod API on each request.

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
- Template ID: 30zmvf89kd
- Minimum workers: 0
- Maximum workers: 3
```

## Contributing

The source is now split by responsibility:

- `src/stdio.ts`: local `stdio` entrypoint.
- `src/http.ts`: shared Streamable HTTP handler.
- `src/tools.ts`: all Runpod MCP tools.
- `src/server.ts`: shared server metadata and construction.
- `api/index.ts`: Vercel adapter.

After changes:

```bash
pnpm type-check
pnpm lint
pnpm build
```

For transport validation:

```bash
pnpm smoke:stdio
pnpm smoke:http
```

This project uses [changesets](https://github.com/changesets/changesets) for versioning and npm publishing. Every PR with user-facing changes needs a changeset file at `.changeset/DESCRIPTIVE_NAME.md`.

See `CLAUDE.md` and `docs/context.md` for contributor guidance.

## Security considerations

This server acts with the full permissions of the supplied `RUNPOD_API_KEY`.

- Never share your API key.
- Be deliberate about destructive tools.
- Treat hosted deployments as sensitive infrastructure.
- Each request authenticates with its own caller-supplied token, which is forwarded to the Runpod API and never persisted server-side.

## License

Apache-2.0
