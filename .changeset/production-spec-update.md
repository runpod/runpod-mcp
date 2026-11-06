---
'@runpod/mcp-server': patch
---

Update `@runpod/plugin-knowledge` from 1.9.0 to 2.0.0, so `list-guides` and `read-guide` serve the latest plugin guides.

Plugin-knowledge 2.0.0 renames the journey guides with a `runpod-` prefix (`pod-doctor` is now `runpod-pod-doctor`). The server instructions name the new ids, and `read-guide` and `runpod://guides/` resource reads still accept the old ids through the bundle's alias map.

Update run: https://github.com/runpod/runpod-mcp/actions/runs/42194967234
