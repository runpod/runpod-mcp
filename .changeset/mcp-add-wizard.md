---
"@runpod/mcp-server": minor
---

Add a guided install wizard. Running `npx @runpod/mcp-server@latest mcp add` detects installed agents (Claude Code, Claude Desktop, Cursor, Windsurf, Visual Studio Code), lets you pick which to configure, helps you grab a Runpod API key, verifies it, and writes the MCP configuration for each selected agent. `mcp remove` undoes the changes. Existing config files keep their formatting and comments.
