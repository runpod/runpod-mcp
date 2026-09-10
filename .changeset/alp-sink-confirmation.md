---
'@runpod/mcp-server': patch
---

ALP ingest now requires the sink's own `{ ok, id }` confirmation before
reporting `recorded: true`, so a success ack always means a stored row rather
than merely a reachable host.
