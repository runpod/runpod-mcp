---
'@runpod/mcp-server': patch
---

Drop the non-portable `pattern` (a `\p{Z}` Unicode property escape) from the `name` argument of `create-global-volume` and `update-global-volume`. OpenAI's plugin tool scan rejected the schema; the API still enforces the rule and the field description states it.
