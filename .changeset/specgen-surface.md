---
'@runpod/mcp-server': minor
---

The hosted (HTTP) path now serves a tool surface generated from the Runpod v2 OpenAPI spec (49 generated + 17 curated tools, including new cluster, SSH-key, and public-template tools), publishes the ten Runpod journey skills as MCP resources under `runpod://skills/`, adds one structured log line per tool call plus a rate-limiter seam, clamps server-side job waits to 45 seconds behind the 60-second gateway deadline, trims and paginates `list-endpoints`, and returns a 400 naming the missing argument when a required tool argument is omitted. The stdio surface is unchanged.
