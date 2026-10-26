---
'@runpod/mcp-server': patch
---

On `/directory`, stop showing credentials: schema examples that name or hold one (such as `{"JUPYTER_PASSWORD": "hunter2"}` on the `env` field) are dropped, and the secret and registry-credential tools (`list-secrets`, `get-secret`, `delete-secret`, `list-registries`, `get-registry`, `delete-registry`) are left out. OpenAI's plugin review rejected the submission for soliciting access credentials. The default surface is unchanged.
