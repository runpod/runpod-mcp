---
'@runpod/mcp-server': minor
---

Take `@runpod/typescript-api-sdk` 0.10.0 from npm, now released from runpod/js-sdk, and generate the tools from the spec it ships (production on 2026-11-24). New tools: `get-catalog-template`, `list-catalog-repos`, `get-catalog-repo` and `get-catalog-repo-readme`. `list-public-templates` takes search, filter, order and paging arguments. `list-gpu-types` and `get-gpu-type` take `minVcpuCountPerGpu` and `minRamPerGpu`. The catalog skill operations are not served: `list-guides` and `read-guide` already serve the same skills.
