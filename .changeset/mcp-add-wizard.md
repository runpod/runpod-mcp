---
"@runpod/mcp-server": minor
---

Add a guided install wizard. Running `npx @runpod/mcp-server@latest mcp add` detects installed agents (Claude Code, Claude Desktop, Cursor, Windsurf, Visual Studio Code), lets you pick which to configure, and writes the MCP configuration for each. It offers two connection modes: a hosted mode that points the agent at the hosted server and authenticates with the "Sign in with Runpod" OAuth flow (no API key stored on disk), and a local mode that runs the server via npx with a `RUNPOD_API_KEY`. `mcp remove` undoes the changes. Existing config files keep their formatting and comments.
