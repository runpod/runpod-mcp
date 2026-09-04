---
'@runpod/mcp-server': patch
---

ALP ingest now requires the sink's own `{ ok, id }` confirmation before
reporting `recorded: true`. A misconfigured sink URL that answers HTTP 200
without storing anything previously produced a successful ack and a lost
entry, indistinguishable from a real write.
