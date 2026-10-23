---
'@runpod/mcp-server': patch
---

Address OpenAI plugin review findings. On `/directory`, `pod-action` is replaced by separate `start-pod`, `stop-pod` and `restart-pod` tools (terminate is `delete-pod`); the default surface keeps `pod-action`. `update-template` is now marked destructive, since it overwrites the image, env and registry and can make a template public.
