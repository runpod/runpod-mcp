---
'@runpod/mcp-server': patch
---

Reject malformed job waits before API calls and cap explicit synchronous waits to the transport limit. Check required Hub environment variables after default resolution and boolean serialization, preventing empty values from reaching endpoint creation while preserving valid false and zero defaults.
