---
'@runpod/mcp-server': minor
---

Send the reshaped v2 Serverless write schema, and support load-balancing endpoints.

`/v2/serverless` changed its create/update contract: endpoint `type` (`QUEUE` or
`LOAD_BALANCER`) is now required on create, the autoscaling object moved from a flat
`{type, value, idleTimeout}` to a per-scaler `{type, queueDelay}` / `{type, requestCount}`,
and `idleTimeout` moved under `workers`. `create-endpoint` and `update-endpoint` now emit
that shape; previously they sent the older one and were rejected with a `422`.

`create-endpoint` gains `endpointType` for queue-based (default) versus load-balancing
request routing. `scalerType` defaults per endpoint type, `scalerValue` defaults to `4`, and
passing `scalerValue` alone on `update-endpoint` keeps the endpoint's current scaler, so
existing calls keep working unchanged. Responses carry `type` and `requestUrls`, and
`get-endpoint` / `list-endpoints` now point at `requestUrls` as the source for an endpoint's
URLs.

**This requires a Runpod API host serving the new schema.** Against a host still on the older
one, endpoint create/update return a `422` naming `queueDelay`/`requestCount`/`idleTimeout` as
not allowed. `RUNPOD_REST_VERSION=v1` remains available for the legacy template-based model.
