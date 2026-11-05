---
'@runpod/mcp-server': minor
---

Pin `@runpod/plugin-knowledge` to an exact version, checked before each release for npm provenance built in `runpod/runpod-plugins-official`, and leave the concept rules listed in `KNOWLEDGE_HIDDEN_RULES` (comma-separated rule ids) out of `lookup-concept` and `search-concepts`, citations included, so the hosted server can withdraw a rule before the knowledge release that deletes it ships. An id the bundle does not hold is logged at startup.
