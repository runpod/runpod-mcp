---
'@runpod/mcp-server': patch
---

Fix multi-value query filters on generated tools. Params the spec declares
`explode: false` (`regions`, `product`, `include`, `countryCodes`,
`cudaVersions`, `compliance`, `networkVolumeTypes`) are now sent as one
comma-joined value instead of a repeated key, which the API rejected with
"parameter 'x' is not exploded, but is specified multiple times". Single-value
filters were unaffected, so this only bit callers passing two or more.
