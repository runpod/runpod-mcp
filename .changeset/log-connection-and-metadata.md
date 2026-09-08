---
'@runpod/mcp-server': patch
---

Report log connection timeouts as failed tool calls while retaining normal snapshots from established streams. Treat an empty Serverless runtime URL as unset. Validate ALP transport metadata before storage and logging so raw input cannot leak into success logs.
