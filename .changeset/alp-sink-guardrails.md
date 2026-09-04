---
'@runpod/mcp-server': patch
---

ALP ingest now refuses a sink URL that is not shaped like the Convex ingest
action, and logs the stored row id on success — the one field that cannot
exist unless a write actually happened.
