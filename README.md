# Runpod MCP Server
[![smithery badge](https://smithery.ai/badge/@runpod/runpod-mcp-ts)](https://smithery.ai/server/@runpod/runpod-mcp-ts)

This Model Context Protocol (MCP) server enables you to interact with the Runpod REST API through Claude or other MCP-compatible clients.

## Features

The server provides tools for managing:

- **Pods**: Create, list, get details, update, start, stop, and delete pods
- **Endpoints**: Create, list, get details, update, and delete serverless endpoints
- **Templates**: Create, list, get details, update, and delete templates
- **Network Volumes**: Create, list, get details, update, and delete network volumes
- **Container Registry Authentications**: Create, list, get details, and delete authentications

## Quick Start

### Prerequisites

- Node.js 18 or higher
- A Runpod account and API key ([get your API key](https://www.runpod.io/console/user/settings))

### Running with npx

You can run the server directly without installation:

```bash
RUNPOD_API_KEY=your_api_key_here npx @runpod/mcp-server@latest
```

### Installing via Smithery

To install for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@runpod/runpod-mcp-ts):

```bash
npx -y @smithery/cli install @runpod/runpod-mcp-ts --client claude
```

## Setting up with Claude for Desktop

1. Open Claude for Desktop
2. Edit the config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
3. Add the server configuration:

```json
{
  "mcpServers": {
    "runpod": {
      "command": "npx",
      "args": ["@runpod/mcp-server@latest"],
      "env": {
        "RUNPOD_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

4. Restart Claude for Desktop

## Usage Examples

### List all pods

```
Can you list all my Runpod pods?
```

### Create a new pod

```
Create a new Runpod pod with the following specifications:
- Name: test-pod
- Image: runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04
- GPU Type: NVIDIA GeForce RTX 4090
- GPU Count: 1
```

### Create a serverless endpoint

```
Create a Runpod serverless endpoint with the following configuration:
- Name: my-endpoint
- Template ID: 30zmvf89kd
- Minimum workers: 0
- Maximum workers: 3
```

## Security Considerations

This server requires your Runpod API key, which grants full access to your Runpod account. For security:

- Never share your API key
- Be cautious about what operations you perform
- Consider setting up a separate API key with limited permissions
- Don't use this in a production environment without proper security measures

## License

Apache-2.0
