---
'@runpod/mcp-server': minor
'@runpod/typescript-api-sdk': minor
---

Add `exec-pod`: run one command in a running Pod's container and get stdout, stderr and the exit code back, with no SSH setup (REST v2 `POST /v2/pods/{id}/exec`). The tool description covers background jobs for long downloads, the 25-second limit, and the 404/409 answers while a new Pod starts. Resync the v2 spec from production; the new signup routes are excluded from the tool surface.
