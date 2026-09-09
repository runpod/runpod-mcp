---
'@runpod/mcp-server': patch
---

The ALP tools' `modelType` field now asks for a best guess at the model and the product running it, with "probably" preferred over leaving it empty. It stays optional. The old "if you know it" wording was read as permission to skip: filled on 1% of Claude Code submissions against 53% of Cursor's.
