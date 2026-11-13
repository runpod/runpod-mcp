---
'@runpod/mcp-server': minor
'@runpod/typescript-api-sdk': minor
---

Resync the v2 spec. New tools: `get-account` (the ID and email of the account the API key belongs to), and `list-queued-pods`, `get-queued-pod` and `delete-queued-pod` (cancel) for Pods queued for deploy-when-available. `create-pod` takes a `queue` option that queues the Pod when its GPU has no capacity. `create-cluster` now accepts `registry` for a private image.
