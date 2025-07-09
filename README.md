# RunPod MCP Server
[![smithery badge](https://smithery.ai/badge/@runpod/runpod-mcp)](https://smithery.ai/server/@runpod/runpod-mcp)

This Model Context Protocol (MCP) server enables you to interact with the RunPod REST API through Claude or other MCP-compatible clients.

## Features

The server provides tools for managing:

- **Pods**: Create, list, get details, update, start, stop, and delete pods
- **Endpoints**: Create, list, get details, update, and delete serverless endpoints
- **Templates**: Create, list, get details, update, and delete templates
- **Network Volumes**: Create, list, get details, update, and delete network volumes
- **Container Registry Authentications**: Create, list, get details, and delete authentications

## Setup

### Prerequisites

- Node.js 18 or higher
- A RunPod account and API key
- Claude for Desktop or another MCP-compatible client

### Installing via Smithery

To install runpod-mcp for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@runpod/runpod-mcp):

```bash
npx -y @smithery/cli install @runpod/runpod-mcp --client claude
```

### Installation

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Build the server:
   ```
   npm run build
   ```

### Configuration

Set your RunPod API key as an environment variable:

```bash
# Linux/macOS
export RUNPOD_API_KEY=your_api_key_here

# Windows (Command Prompt)
set RUNPOD_API_KEY=your_api_key_here

# Windows (PowerShell)
$env:RUNPOD_API_KEY="your_api_key_here"
```

You can get your API key from the [RunPod console](https://www.runpod.io/console/user/settings).

### Running the Server

Start the server:

```bash
npm start
```

## Setting up with Claude for Desktop

1. Open Claude for Desktop
2. Edit the config file: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
3. Add the server configuration:

```json
{
  "mcpServers": {
    "runpod": {
      "command": "node",
      "args": ["/path/to/runpod-mcp-server/build/index.js"],
      "env": {
        "RUNPOD_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

Make sure to replace the `"args": ["/path/to/runpod-mcp-server/build/index.js"]` with the path to the build folder in the repository.

4. Restart Claude for Desktop

## Usage Examples

Here are some examples of how to use the server with Claude:

### List all pods

```
Can you list all my RunPod pods?
```

### Create a new pod

```
Create a new RunPod pod with the following specifications:
- Name: test-pod
- Image: runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04
- GPU Type: NVIDIA GeForce RTX 4090
- GPU Count: 1
```

### Create a serverless endpoint

```
Create a RunPod serverless endpoint with the following configuration:
- Name: my-endpoint
- Template ID: 30zmvf89kd
- Minimum workers: 0
- Maximum workers: 3
```

## Security Considerations

This server requires your RunPod API key, which grants full access to your RunPod account. For security:

- Never share your API key
- Be cautious about what operations you perform
- Consider setting up a separate API key with limited permissions
- Don't use this in a production environment without proper security measures

## License

MIT
