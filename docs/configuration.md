# Configuration

Environment variables and behavior notes for the Runpod MCP server. See the [README](../README.md) for install and connection instructions.

## API hosts

The server is v2-only (the v1 REST API and `RUNPOD_REST_VERSION` are retired). All hosts are env-overridable, read per process:

| Variable | Default | Used for |
| --- | --- | --- |
| `RUNPOD_API_BASE_URL` | `https://api.runpod.io` | REST v2 management API (the generated tools) |
| `RUNPOD_SERVERLESS_API_URL` | `https://api.runpod.ai/v2` | Serverless runtime plane (run/status/stream jobs) |
| `RUNPOD_PUBLIC_GRAPHQL_URL` | `https://api.runpod.io/graphql` | Credential-free discovery (capacity, Hub, public endpoints) |
| `RUNPOD_AUTHED_GRAPHQL_URL` | `https://api.runpod.io/graphql` | GraphQL writes that carry the caller's key — point only at a trusted host |

ALP (Agent Learning Protocol) write tools — `report_feedback` / `save_to_journal` / `ask_question` — are **hosted-only**: they appear only when the deployment configures its storage sink (`ALP_SINK_URL` + `ALP_SINK_SECRET`), and never on local stdio. See `docs/agent-learning-protocol.md`.

To develop against a non-production API, pair the runtime override with the matching spec: `SPEC_URL=... pnpm spec:pull && pnpm generate:tools` (see `specgen/README.md`).

## Serverless endpoint types and autoscaling

`create-endpoint` takes a `body` object matching the REST v2 schema. Set
`body.type` explicitly to `QUEUE` or `LOAD_BALANCER`; it has no default. The
endpoint type cannot be changed after creation.

Set `body.scaling` to `{ "type": "QUEUE_DELAY", "queueDelay": 4 }` for a queue
delay target, or `{ "type": "REQUEST_COUNT", "requestCount": 1 }` for a request
count target. Load-balancing endpoints support request-count scaling only.
Configure worker bounds and idle time under `body.workers` (`min`, `max`,
`idleTimeout`). Idle timeout is rejected for queue endpoints using request-count
scaling. Consult the current tool schema for required fields and numeric limits.

Read `requestUrls` from `get-endpoint` for the runtime URLs; `list-endpoints`
omits those derived URLs. To use a non-production management API, set
`RUNPOD_API_BASE_URL` to its base URL **without `/v2`**. The generated paths
already include that prefix. The legacy `RUNPOD_REST_V2_API_URL` spelling does
not configure the SDK.

## Private image pull: credentials vs ECR delegation

Two ways to let Runpod pull a private image, and they are not interchangeable:

- **`create-registry`** — stores a username + password/token. Works for any registry (Docker Hub, GHCR, Quay, self-hosted). Reference the resulting id from `create-pod` / `create-endpoint` via `body.registry`.
- **`create-delegation`** — **AWS ECR only, no credentials stored.** You register an ECR repository ARN and Runpod is granted scoped pull access; the reply carries a `dockerRegistryUri`. Manage with `list-delegations`, revoke with `revoke-delegation`.

Prefer the delegation for ECR — nothing long-lived is stored on Runpod's side.

## Large tool output

`list-endpoints` and `list-templates` return one page at a time: 20 items by default, up to 100 with `limit`, and `pagination.nextCursor` for the next page. `list-pods`, `list-endpoint-releases`, and `list-endpoint-builds` accept `cursor`/`limit` too, but an omitted `limit` returns up to 1000 items (100 for builds), so pass one to keep output small. Hub and public-endpoint listings also page. Other generated REST lists return the complete upstream list and can still be large. But **Serverless job output** — `run-endpoint`, `runsync-endpoint`, `get-job-status`, and especially `stream-job` — is returned as-is and is **not** size-capped. A very large or long-streaming result can exceed the context window. If output may be huge, have the agent write it to a file, or set `s3Config` on the job so large outputs go to object storage.
