# Runpod MCP server

The official Runpod Model Context Protocol (MCP) server. It lets MCP clients such as Claude Code, Claude Desktop, Cursor, Windsurf, and VS Code manage your Runpod Pods, Serverless endpoints, templates, network volumes, and more.

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

- Node.js 18 or higher.
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

### Usage analytics

The hosted server records one anonymous event per tool call (tool name, status, duration, transport — never your API key, arguments, or any resource data; your identity is an irreversible salted hash). To opt out, send the header `X-Runpod-Analytics: off` — e.g. append `--header "X-Runpod-Analytics: off"` to the `claude mcp add` command. Running locally, nothing is ever sent.

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

## The tool surface

Hosted and local serve the **same** surface: 68 tools generated from the v2
OpenAPI spec (51 generated + 17 curated), plus the ten Runpod task playbooks
served as MCP resources under `runpod://skills/`. New API endpoints become
tools by regeneration, not by hand-writing code. Start with
[specgen/DESIGN.md](specgen/DESIGN.md) for a progressive walkthrough, and
[specgen/README.md](specgen/README.md) for the regeneration workflow and
drift gates.

Upgrading from 3.x: eight tools follow their spec operationIds (e.g.
`create-container-registry-auth` → `create-registry`, `get-billing` →
`list-billing`) and `start-pod`/`stop-pod`/`restart-pod` fold into
`pod-action` with an `action` argument. The full old→new map is
[`specgen/old-mcp-tools.yaml`](specgen/old-mcp-tools.yaml). The server is
v2-only; `RUNPOD_REST_VERSION` and the v1 fallback are retired.

## Security

This server acts with the full permissions of the supplied API key.

- Never share your API key.
- Be deliberate with destructive tools.
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

This project uses [changesets](https://github.com/changesets/changesets) for versioning and npm publishing; every PR with user-facing changes needs a changeset. See `CLAUDE.md` and `docs/context.md` for full contributor guidance, architecture, and the test suite.

## License

Apache-2.0
