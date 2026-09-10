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

`create-endpoint` takes an `endpointType`:

- **`QUEUE`** (default) — jobs go through the managed queue. `run`, `runsync`, `status`, `stream`, `cancel`, `retry`, `purge-queue` and `health` all apply.
- **`LOAD_BALANCER`** — HTTP requests go straight to worker-defined paths. There is no queue, so these endpoints scale on `REQUEST_COUNT` only; `QUEUE_DELAY` is rejected.

An endpoint's type is fixed at creation — `update-endpoint` cannot change it. Read the URLs to call an endpoint with from `requestUrls` on the `get-endpoint` reply rather than constructing them (`list-endpoints` is trimmed and omits them): a queue endpoint returns the full job-API set, a load-balancing one returns its base and health URLs.

Autoscaling is set with `scalerType` (`QUEUE_DELAY` = seconds a request waits in the queue, min `0.5`; `REQUEST_COUNT` = in-flight requests per worker, integer min `1`), `scalerValue` (default `4`), and `idleTimeout` (seconds, `1`–`3600`). `scalerType` defaults to `QUEUE_DELAY` for queue endpoints and `REQUEST_COUNT` for load-balancing ones. `idleTimeout` does not apply to a queue endpoint scaling on `REQUEST_COUNT`.

> **Requires a host serving the reshaped `/v2/serverless` write schema.** These tools send endpoint `type` on create, a per-scaler `scaling` object (`{type, queueDelay}` / `{type, requestCount}`), and `idleTimeout` under `workers`. A host still on the older flat shape rejects that with a `422` naming `queueDelay`/`requestCount`/`idleTimeout` as not allowed. If you hit that, point `RUNPOD_REST_V2_API_URL` at a host with the new schema, (the v1 legacy model is retired).

## Private image pull: credentials vs ECR delegation

Two ways to let Runpod pull a private image, and they are not interchangeable:

- **`create-registry`** — stores a username + password/token. Works for any registry (Docker Hub, GHCR, Quay, self-hosted). Reference the resulting id from `create-pod` / `create-endpoint` via `containerRegistryAuthId`.
- **`create-delegation`** — **AWS ECR only, no credentials stored.** You register an ECR repository ARN and Runpod is granted scoped pull access; the reply carries a `dockerRegistryUri`. Manage with `list-delegations`, revoke with `revoke-delegation`.

Prefer the delegation for ECR — nothing long-lived is stored on Runpod's side.

## Large tool output

Resource **lists** are paginated (default 20 items, `nextCursor`), so a large account can't flood the agent's context. But **Serverless job output** — `run-endpoint`, `runsync-endpoint`, `get-job-status`, and especially `stream-job` — is returned as-is and is **not** size-capped. A very large or long-streaming result can exceed the context window. If output may be huge, have the agent write it to a file, or set `s3Config` on the job so large outputs go to object storage.
