---
'@runpod/mcp-server': patch
---

Declare `type: object` on the `body` argument of the create and update tools whose request body is an `allOf` composition (`create-cluster`, `create-endpoint`, `create-pod`, `create-template`, `update-endpoint`, `update-pod`, `update-template`), so directory reviews that read top-level argument types see one on the full schema served at `/directory`.
