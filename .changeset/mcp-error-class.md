---
'@runpod/mcp-server': patch
---

Record why a hosted tool call failed. Failed calls now carry `error_class` (capacity, balance, validation, auth, permission, not_found, rate_limited, timeout, server and others) on the anonymous analytics event, from a fixed list and never the upstream message. A 400 for "no instances currently available" now gets the capacity hint, the same as "no longer any instances available".
