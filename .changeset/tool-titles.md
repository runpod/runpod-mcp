---
'@runpod/mcp-server': minor
---

Every tool now carries a human-readable `title` in tools/list (for example `List GPU types` for `list-gpu-types`), so hosts can show readable names and the server meets directory review requirements. Generated tools derive the title from their name, with overrides in `specgen/generator-config.yaml`; curated tools declare their own.
