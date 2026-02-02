# Runpod MCP server
[![smithery badge](https://smithery.ai/badge/@runpod/runpod-mcp-ts)](https://smithery.ai/server/@runpod/runpod-mcp-ts)

This Model Context Protocol (MCP) server lets you manage Runpod infrastructure through any MCP-compatible client. It provides tools for working with Pods, Serverless endpoints, templates, network volumes, and container registry authentications.

## Quick start

### Requirements

- Node.js 18 or higher.
- A Runpod account and API key ([get your API key](https://www.runpod.io/console/user/settings)).

### Running with npx

You can run the server directly without installation:

```bash
RUNPOD_API_KEY=YOUR_API_KEY npx @runpod/mcp-server@latest
```

### Installing via Smithery

To install for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@runpod/runpod-mcp-ts):

```bash
npx -y @smithery/cli install @runpod/runpod-mcp-ts --client claude
```

## Setting up with your client

Most MCP clients use a JSON configuration file with the same general structure. The examples below show the npx approach (recommended for most users) and the local build approach (for development). Replace `YOUR_API_KEY` with your actual Runpod API key.

### Claude Code

Add the MCP server globally so it's available across all your projects:

```bash
claude mcp add runpod -s user \
  -e RUNPOD_API_KEY=YOUR_API_KEY \
  -- npx -y @runpod/mcp-server@latest
```

Or add it to a specific project (creates a `.mcp.json` file you can commit):

```bash
claude mcp add runpod -s project \
  -e RUNPOD_API_KEY=YOUR_API_KEY \
  -- npx -y @runpod/mcp-server@latest
```

Verify the server is connected with `claude mcp list`. If you're in an active session, type `/mcp` to reconnect without restarting.

### Claude Desktop

Edit the config file at `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Add the following to `.cursor/mcp.json` in your project directory, or `~/.cursor/mcp.json` for global access:

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

### Windsurf

Open Windsurf settings (Cmd+Shift+P → "Open Windsurf Settings"), navigate to the Cascade section, and enable MCP. Then edit `~/.codeium/windsurf/mcp_config.json`:

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

### VS Code (GitHub Copilot)

MCP works in VS Code's agent mode (requires VS Code 1.101+). Add the following to `.vscode/mcp.json` in your workspace:

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

Click the "Start" button next to the server entry to connect.

### Cline

Open Cline in VS Code, click the hamburger menu (☰), and go to MCP Servers. You can add servers through the marketplace or manually configure in Cline's settings using the same JSON structure shown above.

### JetBrains IDEs

Create a `mcp.json` file at `~/.junie/mcp.json` (global) or `.junie/mcp/` in your project:

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

### Other clients

This server uses stdio transport and works with any MCP-compatible client. The configuration pattern is the same across all clients — point the command to `npx` with `@runpod/mcp-server@latest` as the argument, and set `RUNPOD_API_KEY` in the environment. For a full list of MCP clients, see the [official MCP clients page](https://modelcontextprotocol.io/clients).

## Using a local build

If you want to run from a local clone of the repo (for development or to test unreleased changes):

```bash
git clone https://github.com/runpod/runpod-mcp.git
cd runpod-mcp
pnpm install
pnpm build
```

Then replace the `command` and `args` in any of the configurations above with:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/runpod-mcp/dist/index.mjs"]
}
```

After making changes to the source, re-run `pnpm build` and restart or reconnect the MCP server for changes to take effect.

## Usage examples

### List all Pods

```
Can you list all my Runpod Pods?
```

### Create a new Pod

```
Create a new Runpod Pod with the following specifications:
- Name: test-pod
- Image: runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04
- GPU Type: NVIDIA GeForce RTX 4090
- GPU Count: 1
```

### Create a Serverless endpoint

```
Create a Runpod Serverless endpoint with the following configuration:
- Name: my-endpoint
- Template ID: 30zmvf89kd
- Minimum workers: 0
- Maximum workers: 3
```

## Contributing

To get started with local development, clone the repo and build:

```bash
git clone https://github.com/runpod/runpod-mcp.git
cd runpod-mcp
pnpm install
pnpm build
```

After making changes, rebuild with `pnpm build`. In Claude Code, type `/mcp` to reconnect to the updated server without restarting your session. You can also use `pnpm build:watch` for auto-rebuilding during development.

All tools live in `src/index.ts`. The server uses two backends: the REST API (`runpodRequest()`) for authenticated CRUD operations, and the GraphQL API (`graphqlRequest()`) for public read-only queries like GPU types and data centers. Follow existing patterns when adding new tools — kebab-case names, Zod schemas with `.describe()`, and JSON stringified responses.

This project uses [changesets](https://github.com/changesets/changesets) for versioning and npm publishing. Every PR with user-facing changes needs a changeset file at `.changeset/DESCRIPTIVE_NAME.md`:

```markdown
---
"@runpod/mcp-server": minor
---

Description of what changed and why.
```

Use `patch` for bug fixes, `minor` for new tools or features, and `major` for breaking changes. The `.changeset/` directory is gitignored, so use `git add -f` to stage changeset files.

See [CLAUDE.md](./CLAUDE.md) for the full development guide including architecture details, tool conventions, and known issues.

## Security considerations

This server requires your Runpod API key, which grants full access to your Runpod account. Never share your API key. Be cautious about what operations you perform, and consider setting up a separate API key with limited permissions. Do not use this in a production environment without proper security measures.

## License

Apache-2.0
