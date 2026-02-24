# Runpod MCP Server

This Model Context Protocol (MCP) server enables you to interact with the Runpod REST API through Claude or other MCP-compatible clients.

## Features

The server provides tools for managing:

- **Pods**: Create, list, get details, update, start, stop, and delete Pods.
- **Endpoints**: Create, list, get details, update, and delete Serverless endpoints.
- **Templates**: Create, list, get details, update, and delete templates.
- **Network volumes**: Create, list, get details, update, and delete network volumes.
- **Container registry authentications**: Create, list, get details, and delete authentications.

## Quick start

### Prerequisites

- Node.js 18 or higher
- A Runpod account and API key ([get your API key](https://www.runpod.io/console/user/settings))

### Running with npx

You can run the server directly without installation:

```bash
RUNPOD_API_KEY=your_api_key_here npx @runpod/mcp-server@latest
```

## Setup

### Claude Code

Add the Runpod API MCP server to [Claude Code](https://claude.ai/code):

```bash
claude mcp add runpod --scope user -e RUNPOD_API_KEY=your_api_key_here -- npx -y @runpod/mcp-server@latest
```

Start Claude Code and verify the connection:

```bash
claude
/mcp
```

### Claude Desktop

1. Open Claude Desktop.
2. Edit the config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
3. Add the server configuration:

```json
{
  "mcpServers": {
    "runpod": {
      "command": "npx",
      "args": ["-y", "@runpod/mcp-server@latest"],
      "env": {
        "RUNPOD_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

4. Restart Claude Desktop.

### Cursor

Add to your `.cursor/mcp.json` file:

```json
{
  "mcpServers": {
    "runpod": {
      "command": "npx",
      "args": ["-y", "@runpod/mcp-server@latest"],
      "env": {
        "RUNPOD_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "runpod": {
      "command": "npx",
      "args": ["-y", "@runpod/mcp-server@latest"],
      "env": {
        "RUNPOD_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### Cline

Open the Cline sidebar in VS Code, click the MCP Servers icon, then select **Configure MCP Servers** to edit `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "runpod": {
      "command": "npx",
      "args": ["-y", "@runpod/mcp-server@latest"],
      "env": {
        "RUNPOD_API_KEY": "your_api_key_here"
      },
      "disabled": false
    }
  }
}
```

### Gemini CLI

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "runpod": {
      "command": "npx",
      "args": ["-y", "@runpod/mcp-server@latest"],
      "env": {
        "RUNPOD_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

### OpenAI Codex CLI

```bash
codex mcp add runpod --env RUNPOD_API_KEY=your_api_key_here -- npx -y @runpod/mcp-server@latest
```

### Other clients

For any MCP-compatible client, use the following connection details:

- **Command:** `npx`
- **Args:** `-y @runpod/mcp-server@latest`
- **Environment:** `RUNPOD_API_KEY=your_api_key_here`

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

## Security considerations

This server requires your Runpod API key, which grants full access to your Runpod account. For security:

- Never share your API key.
- Be cautious about what operations you perform.
- Consider setting up a separate API key with limited permissions.
- Don't use this in a production environment without proper security measures.

## License

Apache-2.0
