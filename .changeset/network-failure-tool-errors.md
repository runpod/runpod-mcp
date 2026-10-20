---
'@runpod/mcp-server': patch
---

Network failures reaching the Runpod API (DNS, connection refused, unreachable host, TLS errors, or a connection dropped mid-request) now come back as tool errors with the underlying `cause` code and a recovery hint, instead of escaping as an opaque JSON-RPC `-32603 fetch failed`. Failures where the request never reached Runpod say a retry is safe; a dropped connection says a write may have been applied and to check with a get- or list- tool before calling again.
