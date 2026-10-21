---
'@runpod/mcp-server': patch
---

Every top-level tool argument now declares its `type` (arguments that referenced a shared definition, like `bucketSize`, `cloud` and several request bodies, carried only the reference), and each tool's title is also sent as `annotations.title`. Both were flagged by Anthropic's connector directory review.
