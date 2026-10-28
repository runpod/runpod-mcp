---
'@runpod/mcp-server': patch
---

Drop the `node-fetch` dependency. Only the hosted entry point used it, and that now lives outside this repository.
