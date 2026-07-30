# Configuration

Environment variables and behavior notes for the Runpod MCP server. See the [README](../README.md) for install and connection instructions.

## REST API version (v1 / v2)

The server targets either the v1 REST API (`rest.runpod.io/v1`) or the newer v2 REST API (`v2-rest.runpod.io/v2`). It **defaults to v2**. These variables are read once at startup:

| Variable                         | Values                 | Default                         | Effect                                                      |
| -------------------------------- | ---------------------- | ------------------------------- | ----------------------------------------------------------- |
| `RUNPOD_REST_VERSION`            | `v1` \| `v2` \| `auto` | `v2`                            | Version used for all resources.                             |
| `RUNPOD_REST_VERSION_<RESOURCE>` | `v1` \| `v2` \| `auto` | —                               | Per-resource override (e.g. `RUNPOD_REST_VERSION_PODS=v2`). |
| `RUNPOD_REST_V2_API_URL`         | URL                    | `https://v2-rest.runpod.io/v2`  | v2 base URL.                                                |
| `RUNPOD_REST_API_URL`            | URL                    | `https://rest.runpod.io/v1`     | v1 base URL.                                                |
| `RUNPOD_SERVERLESS_API_URL`      | URL                    | `https://api.runpod.ai/v2`      | Serverless runtime base URL.                                |
| `RUNPOD_AUTHED_GRAPHQL_URL`      | URL                    | `https://api.runpod.io/graphql` | Authenticated GraphQL operations unavailable through REST.  |

Notes:

- To pin a deployment, set `RUNPOD_REST_VERSION` in the host's environment and redeploy. Hosted HTTP honors this default like any other transport.
- `auto` probes v2 once at startup and falls back to v1, but **only on `stdio`** (one process = one key). On hosted HTTP `auto` resolves to `v1`, since a warm instance serves many users and a cached probe verdict could leak across them.
- `jobs` (Serverless runtime) always uses v1 — it has no v2 REST home (it targets `api.runpod.ai/v2`, a separate service).
- The v2-only tools (`list-cpu-types`, `get-gpu-type`, `restart-pod`, and the three `*-registry-delegation(s)` tools) return a clear "v2 only" notice when called under v1.

- `create-pod` for a **CPU pod** (`computeType: "CPU"`) on v2 is served by the v1 API (v2 has no CPU pods yet); the reply is flagged `_servedBy: "v1"`. Since that fallback hits the v1 base, set `RUNPOD_REST_API_URL` to match your environment when targeting a non-prod host. A v2 create with neither `gpuTypeIds` nor `computeType` is rejected — absence is never turned into a CPU pod.

> **Migration note — `create-endpoint` / `update-endpoint` changed in v2.** Serverless endpoints now use an **inline config** instead of a `templateId`: `create-endpoint` requires `imageName` + `gpuPoolIds` (GPU **pool** names from `list-gpu-types`, e.g. `AMPERE_80`), plus optional `workersMin`/`workersMax`, scaler settings, `containerDiskInGb`, `env`, `flashboot`, etc. A pre-existing `{ templateId }` call now returns a clean `400`. Because the current v2 REST facade rebuilds a lossy GPU object on every PATCH, `update-endpoint` additionally requires the complete replacement selection on every call to a **GPU endpoint**: non-empty `gpuPoolIds`, a positive integer `gpuCount`, and `replaceGpuSelection: true`. This cannot preserve `-<GPU type id>` SKU exclusions. CPU serverless endpoints are exempt — they have no GPU selection to lose, which the tool confirms with a same-host read (compute type is fixed at creation, so that read cannot go stale) before patching. Note the current v2 facade itself still rejects CPU-endpoint PATCHes (`400 "gpuId(s) is required for a gpu endpoint"`, observed live); the tool reports that with the missing context and the working escape: set `RUNPOD_REST_VERSION=v1` to update CPU endpoints. Switch to the inline fields, or set `RUNPOD_REST_VERSION=v1` to keep the template-based model.

### Cross-API endpoint safety

`get-endpoint includeGpuIds:true` combines a v2 REST endpoint read with the authoritative
GraphQL `gpuIds`. The production defaults are the only environment pair the client can
verify. If one host is overridden, enrichment is refused. If both hosts are custom, their
different URLs cannot prove they belong to the same dev/staging environment, so enrichment
also fails closed unless the caller explicitly passes
`allowUnverifiedEnvironmentPair:true`; the reply then includes
`_environmentPairUnverified`.

`set-endpoint-gpus` uses authenticated GraphQL for its read/write and the v2 REST GPU
catalog only to validate SKU exclusions. If the catalog is unavailable or its environment
cannot be verified, exclusions fail closed before mutation. Use
`allowUnvalidatedExclusions:true` only when you deliberately accept that a misspelled or
wrong-environment exclusion may exclude nothing and widen placement to the whole pool.

GraphQL `saveEndpoint` also always derives `workersStandby` from `workersMax`. When those
values currently differ, `set-endpoint-gpus` refuses the write unless
`acknowledgeStandbyReset:true` is supplied; an acknowledged success reports both the old
and new standby values. The full read/save is not atomic, so avoid concurrent endpoint
edits.

## Serverless endpoint types and autoscaling

`create-endpoint` takes an `endpointType`:

- **`QUEUE`** (default) — jobs go through the managed queue. `run`, `runsync`, `status`, `stream`, `cancel`, `retry`, `purge-queue` and `health` all apply.
- **`LOAD_BALANCER`** — HTTP requests go straight to worker-defined paths. There is no queue, so these endpoints scale on `REQUEST_COUNT` only; `QUEUE_DELAY` is rejected.

An endpoint's type is fixed at creation — `update-endpoint` cannot change it. Read the URLs to call an endpoint with from `requestUrls` on the `get-endpoint` / `list-endpoints` reply rather than constructing them: a queue endpoint returns the full job-API set, a load-balancing one returns its base and health URLs.

Autoscaling is set with `scalerType` (`QUEUE_DELAY` = seconds a request waits in the queue, min `0.5`; `REQUEST_COUNT` = in-flight requests per worker, integer min `1`), `scalerValue` (default `4`), and `idleTimeout` (seconds, `1`–`3600`). `scalerType` defaults to `QUEUE_DELAY` for queue endpoints and `REQUEST_COUNT` for load-balancing ones. `idleTimeout` does not apply to a queue endpoint scaling on `REQUEST_COUNT`.

> **Requires a host serving the reshaped `/v2/serverless` write schema.** These tools send endpoint `type` on create, a per-scaler `scaling` object (`{type, queueDelay}` / `{type, requestCount}`), and `idleTimeout` under `workers`. A host still on the older flat shape rejects that with a `422` naming `queueDelay`/`requestCount`/`idleTimeout` as not allowed. If you hit that, point `RUNPOD_REST_V2_API_URL` at a host with the new schema, or set `RUNPOD_REST_VERSION=v1` for the legacy template-based model.

## Private image pull: credentials vs ECR delegation

Two ways to let Runpod pull a private image, and they are not interchangeable:

- **`create-container-registry-auth`** — stores a username + password/token. Works for any registry (Docker Hub, GHCR, Quay, self-hosted), on v1 and v2. Reference the resulting id from `create-pod` / `create-endpoint` via `containerRegistryAuthId`.
- **`create-registry-delegation`** — **AWS ECR only, v2-only, no credentials stored.** You register an ECR repository ARN and Runpod is granted scoped pull access; the reply carries a `dockerRegistryUri`. Manage with `list-registry-delegations`, revoke with `delete-registry-delegation`.

Prefer the delegation for ECR — nothing long-lived is stored on Runpod's side.

## Large tool output

Resource **lists** are paginated (default 20 items, `nextCursor`), so a large account can't flood the agent's context. But **Serverless job output** — `run-endpoint`, `runsync-endpoint`, `get-job-status`, and especially `stream-job` — is returned as-is and is **not** size-capped. A very large or long-streaming result can exceed the context window. If output may be huge, have the agent write it to a file, or set `s3Config` on the job so large outputs go to object storage.
