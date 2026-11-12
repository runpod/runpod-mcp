---
'@runpod/mcp-server': patch
---

The hosted 404 loop breaker now counts and blocks only `get-pod`, which caused 519 of the 559 blocks in the last month. 404s from other tools, such as `exec-pod` retried while a new Pod is still being created, no longer count toward a block.
