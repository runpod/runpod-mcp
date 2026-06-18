---
"@runpod/mcp-server": patch
---

Support naming the minted Runpod API key in the OAuth flow. Set `RUNPOD_API_KEY_NAME` (e.g. `runpod-mcp`) to pass `apiKeyName` through to the flash backend's `createFlashAuthRequest`, so the key shows up under that name in the user's dashboard. It is omitted by default for compatibility with backends that don't yet support the argument.
