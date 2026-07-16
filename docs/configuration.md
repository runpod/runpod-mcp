# Configuration

Environment variables and behavior notes for the Runpod MCP server. See the [README](../README.md) for install and connection instructions.

## REST API version (v1 / v2)

The server targets either the v1 REST API (`rest.runpod.io/v1`) or the newer v2 REST API (`v2-rest.runpod.io/v2`). It **defaults to v2**. These variables are read once at startup:

| Variable                         | Values                 | Default                        | Effect                                                      |
| -------------------------------- | ---------------------- | ------------------------------ | ----------------------------------------------------------- |
| `RUNPOD_REST_VERSION`            | `v1` \| `v2` \| `auto` | `v2`                           | Version used for all resources.                             |
| `RUNPOD_REST_VERSION_<RESOURCE>` | `v1` \| `v2` \| `auto` | —                              | Per-resource override (e.g. `RUNPOD_REST_VERSION_PODS=v2`). |
| `RUNPOD_REST_V2_API_URL`         | URL                    | `https://v2-rest.runpod.io/v2` | v2 base URL.                                                |
| `RUNPOD_REST_API_URL`            | URL                    | `https://rest.runpod.io/v1`    | v1 base URL.                                                |
| `RUNPOD_SERVERLESS_API_URL`      | URL                    | `https://api.runpod.ai/v2`     | Serverless runtime base URL.                                |

Notes:

- To pin a deployment, set `RUNPOD_REST_VERSION` in the host's environment and redeploy. Hosted HTTP honors this default like any other transport.
- `auto` probes v2 once at startup and falls back to v1, but **only on `stdio`** (one process = one key). On hosted HTTP `auto` resolves to `v1`, since a warm instance serves many users and a cached probe verdict could leak across them.
- `jobs` (Serverless runtime) always uses v1 — it has no v2 REST home (it targets `api.runpod.ai/v2`, a separate service).
- The v2-only tools (`list-cpu-types`, `get-gpu-type`, `restart-pod`, and the three `*-registry-delegation(s)` tools) return a clear "v2 only" notice when called under v1.

- `create-pod` for a **CPU pod** (`computeType: "CPU"`) on v2 is served by the v1 API (v2 has no CPU pods yet); the reply is flagged `_servedBy: "v1"`. Since that fallback hits the v1 base, set `RUNPOD_REST_API_URL` to match your environment when targeting a non-prod host. A v2 create with neither `gpuTypeIds` nor `computeType` is rejected — absence is never turned into a CPU pod.

> **Migration note — `create-endpoint` / `update-endpoint` changed in v2.** Serverless endpoints now use an **inline config** instead of a `templateId`: `create-endpoint` requires `imageName` + `gpuPoolIds` (GPU **pool** names from `list-gpu-types`, e.g. `AMPERE_80`), plus optional `workersMin`/`workersMax`, scaler settings, `containerDiskInGb`, `env`, `flashboot`, etc. A pre-existing `{ templateId }` call now returns a clean `400`. Switch to the inline fields, or set `RUNPOD_REST_VERSION=v1` to keep the template-based model.

## Private image pull: credentials vs ECR delegation

Two ways to let Runpod pull a private image, and they are not interchangeable:

- **`create-container-registry-auth`** — stores a username + password/token. Works for any registry (Docker Hub, GHCR, Quay, self-hosted), on v1 and v2. Reference the resulting id from `create-pod` / `create-endpoint` via `containerRegistryAuthId`.
- **`create-registry-delegation`** — **AWS ECR only, v2-only, no credentials stored.** You register an ECR repository ARN and Runpod is granted scoped pull access; the reply carries a `dockerRegistryUri`. Manage with `list-registry-delegations`, revoke with `delete-registry-delegation`.

Prefer the delegation for ECR — nothing long-lived is stored on Runpod's side.

## Large tool output

Resource **lists** are paginated (default 20 items, `nextCursor`), so a large account can't flood the agent's context. But **Serverless job output** — `run-endpoint`, `runsync-endpoint`, `get-job-status`, and especially `stream-job` — is returned as-is and is **not** size-capped. A very large or long-streaming result can exceed the context window. If output may be huge, have the agent write it to a file, or set `s3Config` on the job so large outputs go to object storage.
