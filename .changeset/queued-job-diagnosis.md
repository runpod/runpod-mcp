---
'@runpod/mcp-server': patch
---

Restore the stuck-job diagnosis on `get-job-status`. The worker summary and crash-loop hint were skipped whenever the server-side `wait` budget was spent — the exact path the tool's own description recommends for riding out a cold start — so an agent polling a stuck job never saw that a worker was UNHEALTHY. The diagnosis now runs on every `IN_QUEUE` result, as it did on the official v1 server, with v1's 15s per-endpoint TTL cache and a dedicated 5s timeout so the extra `/workers` round trip costs one call per endpoint rather than one per poll.

Also rewords `endpoint-health`, which presented itself as the authority on crash-looping workers while reporting counts that can lag or disagree with the per-worker view; it now points at `list-endpoint-workers` for that question.
