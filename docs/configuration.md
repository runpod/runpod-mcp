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
| `RUNPOD_MCP_URL` | `https://mcp.runpod.io/` | Hosted server that stdio `search-docs` calls with the caller's key — point only at a trusted host |

ALP (Agent Learning Protocol) tools — `report_feedback` / `save_to_journal` / `ask_question` / `read_journal` / `report_how_user_found_runpod` / `rate_nps_score` — are **hosted-only**: they appear only when the deployment configures its storage sink (`ALP_SINK_URL` + `ALP_SINK_SECRET`), and never on local stdio. `report_how_user_found_runpod` is asked once per account: on each `initialize` with a resolved account the server checks the sink and omits the ask from the instructions once the account has answered (any lookup failure keeps the ask; the sink declines a second answer either way). See `docs/agent-learning-protocol.md`.

`search-docs` searches the Runpod docs, curated support knowledge, blog and site through the runpod-assistant knowledge index. The hosted server lists it when it holds the index's service key (`KNOWLEDGE_SEARCH_URL` + `RUNPOD_ASSISTANT_API_KEY`) and searches in-process. Local stdio calls the hosted `POST /api/search` with your own API key, so the npm package never holds the service key. Capacity rejections from the index (503, 429) are retried server-side with jittered backoff.

To develop against a non-production API, pair the runtime override with the matching spec: `SPEC_URL=... pnpm spec:pull && pnpm generate` (see `specgen/README.md`).

## Hiding a concept rule

`lookup-concept` and `search-concepts` serve the concept rules of the `@runpod/plugin-knowledge` version that `package.json` pins exactly. Each release checks that this version was published with npm provenance built in `runpod/runpod-plugins-official` (`pnpm knowledge:provenance`). A rule is withdrawn by deleting it in a patch release of that package, which reaches users with the next `@runpod/mcp-server` release. Until then the hosted server can hide it: set `KNOWLEDGE_HIDDEN_RULES` to the rule ids, comma-separated, as the `id` field of `search-concepts` shows them. The server reads the variable once at startup and leaves those rules out of `search-concepts` and `lookup-concept`, including every place a rule id is cited: a rule's `see`, a step's `rules`, a doc's `rules` and `linked_rules`. An id the pinned bundle does not hold is logged at startup as `knowledge_hidden_rule_unknown`: a typo, or a rule that a later release already deleted. Set it on the hosted server only; local installs get the withdrawal from the release. A disputed rule is not hidden: it is served with `conflict: true`.

## Argument validation

Every tool call is checked against the tool's full input schema, the same schema `tools/list` advertises (or, for a tool that lists only its call shape, the one `describe-tool` returns). That covers types, enums, ranges and nested fields, not just the top-level required and unknown arguments the server always rejects. `MCP_SCHEMA_VALIDATION` decides what happens to a call that fails the check. It defaults to `shadow`: the call goes out unchanged, and the server logs a `schema_violation` line carrying the tool name and, for each failure, the schema keyword and schema location, never argument values. `enforce` rejects the call before any request is built, with an `invalid_arguments` error that lists each field's path, the problem, and the allowed values for an enum. `off` skips the check.

Shadow is the default because the vendored OpenAPI spec can be stricter than the live API, and a call the API accepts must not be blocked by this server. Read the `schema_violation` lines before switching to `enforce`. A violation on a call that succeeded upstream points at a spec mismatch, to fix in `packages/typescript-api-sdk/scripts/fix_spec.py`. A `null` sent for an optional argument, at any depth, counts as omitted, as do the empty optional query parameters the server already drops. Formats are not checked here; the API checks them. The ALP write tools, which never return an error by design, are not checked.

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
