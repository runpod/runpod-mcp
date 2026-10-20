---
'@runpod/mcp-server': patch
---

Correct the MCP annotations on tools whose HTTP method understated what they do, so hosts gate them on a human. `update-endpoint`, `update-pod`, `update-secret`, `set-endpoint-gpus` and `retry-job` are now marked destructive: each can clear settings it was not sent, restart a container, overwrite a value that cannot be read back, or remove prior job output. `stream-job` is no longer marked read-only, because the stream hands out each chunk once. `create-secret` and the field-setting updates (`update-cluster`, `update-network-volume`, `update-global-volume`, `update-template`) are now marked idempotent.
