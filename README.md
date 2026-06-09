# Runpod MCP server
[![smithery badge](https://smithery.ai/badge/@runpod/runpod-mcp-ts)](https://smithery.ai/server/@runpod/runpod-mcp-ts)

This is the official Runpod Model Context Protocol (MCP) server, published to npm as `@runpod/mcp-server`.

It supports two deployment modes:

- Local `stdio` for Claude Desktop, Claude Code, Cursor, VS Code, and other MCP clients that launch a local process.
- Hosted Streamable HTTP for Vercel or other HTTP-capable platforms where the caller sends `Authorization: Bearer <RUNPOD_API_KEY>` on each request.

The hosted path can also run in a temporary OAuth translation mode for remote Claude connector testing with a non-Runpod Clerk tenant.

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
- The caller must send `Authorization: Bearer <RUNPOD_API_KEY>`.
- No API keys are cached server-side.

### Hosted auth modes

Default hosted mode:

- incoming bearer token: direct Runpod API key
- outbound bearer token to Runpod: same token

Temporary OAuth translation mode:

- `CLERK_OAUTH_DISCOVERY_URL`: Clerk discovery URL such as `https://clerk.openv.ai/.well-known/openid-configuration`
- `RUNPOD_HTTP_SHARED_API_KEY`: shared server-side Runpod API key for outbound requests

In that mode:

- incoming bearer token: Clerk-issued OAuth access token
- outbound bearer token to Runpod: shared server-side API key

This exists only to test remote Claude connectors before switching to the real Runpod Clerk tenant. Keep it clearly marked as temporary infrastructure.

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

The current hosted deployment expects a pre-shared bearer token on every request. Claude's remote connector flow is designed for authless or OAuth-based remote MCP servers, so this Vercel deployment is not a drop-in Claude remote connector as-is.

When OAuth translation mode is enabled, the hosted deployment becomes suitable for remote Claude connector testing while still calling Runpod with a shared API key on the backend.

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
- Do not expose an authless hosted deployment unless you explicitly intend to share one Runpod account behind it.
- If you enable OAuth translation mode, all authenticated users share one backend Runpod API key until you replace it with a real per-user Runpod auth strategy.

## License

Apache-2.0
