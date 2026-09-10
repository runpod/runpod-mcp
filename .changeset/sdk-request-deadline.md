---
'@runpod/mcp-server': patch
---

Bound every generated-tool (SDK) request with a 30s client-side deadline. A host that accepted the connection then went silent previously parked the call until the platform reaper — the same leak class PR #83 fixed on the old surface. A fired deadline now surfaces as a retryable 504 tool result instead of a hang.
