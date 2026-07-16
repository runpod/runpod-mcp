# Runpod MCP server

[![smithery badge](https://smithery.ai/badge/@runpod/runpod-mcp-ts)](https://smithery.ai/server/@runpod/runpod-mcp-ts)

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

> Prefer your own API key over OAuth? Append `--header "Authorization: Bearer YOUR_API_KEY"` to the `claude mcp add` command (or add a `headers` block in the JSON). The server forwards that key to the Runpod API directly.

## Run locally with `npx`

Run the server as a local `stdio` process with your own API key:

```bash
RUNPOD_API_KEY=YOUR_API_KEY npx -y @runpod/mcp-server@latest
```

Or install via [Smithery](https://smithery.ai/server/@runpod/runpod-mcp-ts):

```bash
npx -y @smithery/cli install @runpod/runpod-mcp-ts --client claude
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

On the v2 API (the default), endpoints are image-based — pass an image and a GPU pool (a `pool` value from `list-gpu-types`), not a template.

See [`docs/configuration.md`](docs/configuration.md) for REST v1/v2 selection and the `templateId` migration note, private image pull (registry credentials vs ECR delegation), and large-output handling.

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
