---
'@runpod/mcp-server': patch
---

Curated tools now reject a misnamed or missing argument before any request goes out, with the same wording and stale-schema hint the generated tools use. Previously `stream-pod-logs` called with `id` instead of `podId` fetched `/pods/undefined/logs` and returned a confident 404 "pod not found". The ALP write tools are exempt, keeping their fail-soft contract.
