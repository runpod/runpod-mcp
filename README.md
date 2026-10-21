# Runpod MCP server

The official Runpod Model Context Protocol (MCP) server. It lets MCP clients such as Claude Code, Claude Desktop, Cursor, Windsurf, VS Code, opencode, and Pi manage your Runpod Pods, Serverless endpoints, templates, network volumes, and more.

**We host it for you at [`https://mcp.getrunpod.io/`](https://mcp.getrunpod.io/)** — point your client at that URL and sign in with Runpod. Nothing to install, no API key on disk. Or run it locally from npm as [`@runpod/mcp-server`](https://www.npmjs.com/package/@runpod/mcp-server).

## Quick start

The guided installer detects the clients you have installed, asks which to configure, and writes the config for you:

```bash
npx @runpod/mcp-server@latest add
```

It offers two connection modes:

- **Hosted (recommended)** — points the client at the hosted server and authenticates with "Sign in with Runpod" (OAuth). No API key is stored on disk.
- **Local** — runs the server through `npx` and stores a `RUNPOD_API_KEY` in the client's config.

To undo later:

```bash
npx @runpod/mcp-server@latest remove
```

To skip the prompts (from a script, CI, or a coding agent's shell), name the clients. Supported ids are `claude-code`, `cursor`, `windsurf`, `claude-desktop`, `vscode`, `opencode`, and `pi`:

```bash
npx @runpod/mcp-server@latest add --client opencode,pi          # hosted, sign in with Runpod
npx @runpod/mcp-server@latest add --client cursor --local       # local, key read from RUNPOD_API_KEY
npx @runpod/mcp-server@latest remove --client opencode
npx @runpod/mcp-server@latest add --list                        # what's detected, and where each config lives
```

Without `--client` and without a terminal, the installer exits with code 2 and configures nothing. With flags it exits 0 when every client was configured and 1 when one failed.

### Or install the whole Runpod plugin

For the full agent setup, the [official plugin marketplace](https://github.com/runpod/runpod-plugins-official) bundles this server with a router skill plus five more — `runpod-mcp`, `runpodctl`, `flash`, `runpod-usage`, and `companion-clis`:

```bash
npx skills add runpod/runpod-plugins-official
```

That works in Claude Code, Codex, Cursor, Copilot, Windsurf, Cline, Gemini, opencode, and 17+ other agents, and installs the skills — pair it with `npx @runpod/mcp-server@latest add` above for the control-plane tools.

In **Claude Code**, the native plugin route also wires up the hosted MCP server for you (OAuth included), so no separate setup is needed:

```
/plugin marketplace add runpod/runpod-plugins-official
/plugin install runpod@runpod
```

### Requirements

- Node.js 20 or higher.
- A Runpod account and [API key](https://www.runpod.io/console/user/settings).

## Connect to the hosted server

To configure a client by hand, point it at the hosted server over HTTP (no local process, no API key stored).

**Claude Code:**

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

An OAuth-capable client starts the "Sign in with Runpod" flow automatically on first connect: it opens a browser, you log in to the Runpod console and approve, and the server obtains a Runpod API key scoped to your session. Nothing is stored on disk.

> **Which account does OAuth pick?** The key is minted for whichever account or team profile your browser's console session has selected when you approve. If you belong to multiple teams, switch to the right profile in the [console](https://console.runpod.io) first (or check afterwards — the resources the tools return are that profile's). To change it later, switch profiles in the console and re-authenticate from your MCP client.

> Prefer your own API key over OAuth? Append `--header "Authorization: Bearer YOUR_API_KEY"` to the `claude mcp add` command (or add a `headers` block in the JSON). The server forwards that key to the Runpod API directly.

### If sign-in fails with HTTP 403

A `403 Forbidden` response with the header `X-Vercel-Mitigated: deny` means the hosted server's firewall has temporarily blocked your IP address, usually after a burst of unauthenticated requests from an MCP client. This happens most often with Codex, which sends many unauthenticated requests while it signs in. The block covers every path, including `/register` and requests that carry an API key, and lifts on its own within an hour. Wait for it to expire, then use one of these options so the next connection doesn't trip it again.

You can send your API key as a header instead of signing in with OAuth, as described above. Authenticated requests don't count toward the limit. In Codex, add the key to the server entry in `~/.codex/config.toml`:

```toml
[mcp_servers.runpod]
url = "https://mcp.getrunpod.io/"
bearer_token_env_var = "RUNPOD_API_KEY"
```

Then export `RUNPOD_API_KEY` in the shell that launches Codex.

You can also [run the server locally](#run-locally-with-npx). The local server calls the Runpod API directly, so the hosted firewall only affects its `search-docs` tool, which still searches through the hosted server.

### Usage analytics

The hosted server records one anonymous event per tool call (tool name, status, duration, transport) and per guide resource read (guide URI, or `unknown` on a miss), plus one event when it starts blocking a 404 loop (tool name and block length). It never records your API key or any resource data, and drops tool arguments except on the guide and concept tools (`list-guides`, `read-guide`, `lookup-concept`, `search-concepts`), where it keeps the guide id, concept name or search words, plus the kind of guide read. Your identity is an irreversible salted hash. To opt out, send the header `X-Runpod-Analytics: off` — e.g. append `--header "X-Runpod-Analytics: off"` to the `claude mcp add` command. Running locally, nothing is ever sent.

## Run locally with `npx`

Run the server as a local `stdio` process with your own API key:

```bash
RUNPOD_API_KEY=YOUR_API_KEY npx -y @runpod/mcp-server@latest
```

### Local client setup

Local clients launch the `stdio` server and set `RUNPOD_API_KEY` in the environment.

**Claude Code:**

```bash
claude mcp add runpod -s user \
  -e RUNPOD_API_KEY=YOUR_API_KEY \
  -- npx -y @runpod/mcp-server@latest
```

Use `-s project` for a project-local server. Verify with `claude mcp list`; in a session, `/mcp` reconnects.

**Claude Desktop, Cursor, VS Code, Windsurf, and other clients** — use the same command in the client's MCP config:

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

Claude Desktop's config lives at `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows); restart the app after saving. For a broader list of clients, see the [MCP clients directory](https://modelcontextprotocol.io/clients).

## Usage examples

Ask your MCP client in natural language:

```text
List all my Runpod Pods.
```

```text
Create a Runpod Pod named test-pod with image
runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04,
GPU type NVIDIA GeForce RTX 4090, 1 GPU.
```

```text
Create a Serverless endpoint named my-endpoint with image
runpod/test-output:0.0.1, GPU pool AMPERE_80, 0 min workers, 3 max workers.
```

Endpoints are image-based — pass an image and a GPU pool (a `pool` value from `list-gpu-types`), not a template.

See [`docs/configuration.md`](docs/configuration.md) for host overrides, private image pull (registry credentials vs ECR delegation), and large-output handling.

## Upgrading from 3.x

Eight tools follow their spec operationIds (e.g.
`create-container-registry-auth` → `create-registry`, `get-billing` →
`list-billing`) and `start-pod`/`stop-pod`/`restart-pod` fold into
`pod-action` with an `action` argument. The full old→new map is
[`specgen/old-mcp-tools.yaml`](specgen/old-mcp-tools.yaml). The server is
v2-only; `RUNPOD_REST_VERSION` and the v1 fallback are retired.

## Security

This server acts with the full permissions of the supplied API key.

- Never share your API key.
- Be deliberate with destructive tools. Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) derived from the operation it wraps, so a host can auto-approve reads and gate `delete-pod` or `purge-endpoint-queue` on a human.
- Each request authenticates with its own caller-supplied token, which is forwarded to the Runpod API and **never persisted server-side**. The server never holds a credential of its own and never shares one across users.

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

After changes:

```bash
pnpm type-check
pnpm lint
pnpm test    # offline unit suite — no network or API key required
pnpm build
```

Tools are generated from the vendored v2 OpenAPI spec rather than hand-written: see [specgen/DESIGN.md](specgen/DESIGN.md) for the walkthrough and [specgen/README.md](specgen/README.md) for the regeneration workflow and drift gates.

The REST client the tools call, [`@runpod/typescript-api-sdk`](https://www.npmjs.com/package/@runpod/typescript-api-sdk), lives in [`packages/typescript-api-sdk/`](packages/typescript-api-sdk/) and is published to npm separately. The vendored spec is in that package; both the SDK types and the MCP tools generate from it.

This project uses [changesets](https://github.com/changesets/changesets) for versioning and npm publishing; every PR with user-facing changes needs a changeset. See `CLAUDE.md` and `docs/context.md` for full contributor guidance, architecture, and the test suite.

## License

Apache-2.0. The SDK in `packages/typescript-api-sdk/` is MIT-licensed; see its `LICENSE`.

### JavaScript API migration

This major release removes the `@runpod/mcp-server/tools` package export and
its `registerTools` API. The legacy registration API is not compatible with
the new generated surface. Applications should connect to the server through
MCP using the `runpod-mcp` CLI, or use `handleMcpRequest` from
`@runpod/mcp-server/http` when embedding the HTTP handler. The HTTP entry point
also no longer re-exports the legacy `registerTools` or `ToolContext`.
