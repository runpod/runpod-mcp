---
'@runpod/mcp-server': patch
---

Record the tool surface on each `runpod_mcp_tool_call` analytics event as `profile` (`directory` for `mcp.runpod.io/directory`, `default` otherwise), so directory traffic (the ChatGPT plugin and the Claude connector) can be told apart from custom connectors on `/`.
