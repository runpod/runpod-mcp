---
"@runpod/mcp-server": minor
---

Add caller tracking headers to every outbound API call. Each request now carries a structured `User-Agent` (`runpod-mcp-server/<version> (caller=mcp; client=<mcp_client_name>; client_version=<mcp_client_version>; transport=<stdio|http>)`) and an anonymous per-process `X-Runpod-Session-Id` UUID. The MCP client identity is sourced from the `initialize` handshake's `clientInfo`. No tool behavior changes — observability only — so the Runpod platform can attribute traffic to specific MCP clients (Claude Code, Cursor, Codex, Gemini CLI, etc.) and count distinct agent sessions.
