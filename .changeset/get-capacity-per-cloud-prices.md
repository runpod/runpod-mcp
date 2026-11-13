---
'@runpod/mcp-server': patch
---

`get-capacity` now returns `securePricePerGpuHr` and `communityPricePerGpuHr` next to `pricePerHr`, which is the cheapest price across both clouds unless `secureCloudOnly` is set.
