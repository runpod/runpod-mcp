---
'@runpod/mcp-server': patch
---

A client whose name or version contains CJK text, an emoji or a NUL character no longer fails every Runpod request on stdio. The tracking User-Agent now keeps only RFC 9110 token characters and maps every other character to `_`.
