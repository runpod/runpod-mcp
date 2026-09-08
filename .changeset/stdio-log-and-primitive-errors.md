---
'@runpod/mcp-server': patch
---

Write operational tool logs to stderr so local stdio clients receive only JSON-RPC on stdout. Preserve rate-limit wait hints for plain-text and JSON primitive error responses.
