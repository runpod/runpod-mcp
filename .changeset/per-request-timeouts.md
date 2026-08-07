---
'@runpod/mcp-server': minor
---

Give every outbound request a client-side deadline. node-fetch applies no timeout of its own, so a Runpod host that accepted the connection and then went silent — a wedged worker, a load balancer holding the socket — left a tool call pending forever, and on the hosted server that ended as a bare 504 when Vercel reaped the function at its 60s limit.

Requests now abort after 30 seconds with a named `RequestTimeoutError` naming the API that went quiet, the deadline it was given, and what to do next. `runsync-endpoint` is the one call that legitimately asks the server to hold a connection open, so it derives its deadline from the `wait` it requested (the server's own 90-second default when `wait` is omitted) rather than being truncated. Successful tool output is unchanged.

On the hosted transport the cap is a single budget for the whole invocation rather than a fresh allowance per request, because several tools make more than one call — `get-job-status` adds a queued-job diagnosis, `deploy-hub-repo` and `set-endpoint-gpus` read before they write, `update-endpoint` reads the current scaler before patching it — and two full deadlines back to back outlived the platform even with each one bounded. Each request is clamped to what is left, so a stall anywhere in a handler surfaces as the named error instead of a 504. The queued-job diagnosis, which only decorates a status that is already in hand, is bounded at 5 seconds so it cannot spend a budget the reply itself needs.

A timed-out GraphQL read is also no longer described as a possible write. The advice keys off the HTTP method and GraphQL is always POST on the wire, so `list-gpu-types` timing out used to tell the agent the call may have landed and to "check with the matching list-/get- tool first" — which is the tool that just failed. Only actual mutations carry that warning now.
