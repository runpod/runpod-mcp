---
'@runpod/mcp-server': patch
---

Stop treating UNHEALTHY as the test for a crash-looping worker. A container
that fails to start loops while its worker still reports RUNNING or THROTTLED
and `unhealthy` stays 0, so `get-job-status` now returns a hint pointing at
`stream-worker-logs` for that case instead of an empty one, and the
`get-job-status` / `endpoint-health` / `stream-worker-logs` descriptions and
the endpoint-ops / serverless-deploy skills say the logs are the authority.
