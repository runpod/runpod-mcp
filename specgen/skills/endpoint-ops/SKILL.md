---
name: endpoint-ops
description: >-
  Operate a Serverless endpoint that already exists: diagnose queued jobs and dying workers, tune scaling, idle
  timeout and FlashBoot safely, pin the GPU selection, and manage the queue (cancel a job, purge). Read-only by
  default; changes only the exact setting the user authorized, with a read before and after. Use when the user
  has an endpoint and asks why it is slow, stuck or failing, or wants one of its settings changed through the
  Runpod MCP tools.
metadata:
  concepts: [serverless-endpoint, endpoint-autoscaling, worker, job, flashboot, gpu-pool, log-stream, endpoint-release]
---

# Endpoint ops

You operate a Serverless endpoint that already exists. Everything starts by reading its current state (the endpoint config, its health, its workers, its logs) before you say anything or change anything. Diagnosis is always read-only. You change a setting only when the user asked for a change, and then only the exact setting agreed.

One property of the Runpod update path drives the central rule here: an endpoint update is a PATCH. Only the fields present in the body change and omitted fields are left untouched, so you send exactly the setting you were asked to change and nothing else. The one exception is the GPU selection: `gpu.pools` and `gpu.excludedTypes` are a single selection, so a PATCH that sends `pools` without `excludedTypes` clears the exclusions. When you touch either, send both. What the PATCH does not give you is proof: its own response is not a read. Read the config first for the before value, and read it back afterward for the after value.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the tool binding below. This skill reads before it mutates, and mutates only what the user authorized.

- List and inspect endpoints: resolve "which endpoint" and read the full current config.
- Read endpoint health and list workers: the stuck-queue / dying-worker evidence.
- Read a worker's logs: the crash / model-load failure line.
- Read GPU stock per data center, with the CUDA versions that have capacity: is a stuck queue a capacity problem?
- Update an endpoint (worker min/max, idle timeout, scaler, FlashBoot, disk, env): the gated tune.
- Pin GPUs / set GPU count: the pool plus `excludedTypes` selection and `gpu.count`; `set-endpoint-gpus` builds it and preserves the other settings.
- Read release history: which build the workers are running.
- Cancel one job; purge the queue. These are the queue-management actions, each gated.
- Submit and poll a job to re-verify after a change.

## Phase 1 — diagnose (always, read-only)

Resolve the endpoint (list endpoints and match by name if needed), read its config, then read health and workers before forming a conclusion. Classify against the symptom:

- **Jobs stuck `IN_QUEUE`.** Read health and the worker list. If max workers is 0 or all workers are throttled/unhealthy, the queue has nothing to run on. An endpoint idle for 3 days has `workers.max` lowered to 2 and after 7 days to 0, and it stays there until raised, so a long-idle endpoint "stuck" on its first job is usually this. Separate the causes: worker **limit** (max-workers too low or lowered by idleness, or min 0 with a cold scaler) vs **capacity** (workers can't acquire the selected GPU: `throttled` above 0; cross-check that GPU type's availability with `product:["SERVERLESS"]`, and its CUDA versions with capacity when the endpoint pins a CUDA floor) vs **crash loop** (workers cycling: read their logs with `source=system`; a container that exits before the handler runs can still report RUNNING or INITIALIZING while the job stays queued, so the logs settle it, not the worker status). Name which one, quoting the health/worker numbers you read.
- **Workers crash-looping.** List workers, find the failing ones, read their logs, and quote the decisive line: a missing model file, a gated 403, an OOM, a bad handler import. Report what the log says, not a guess. OOM → the GPU is undersized for the real memory pattern; a load/import error → the image or env is wrong.
- **Cold starts hurt.** Read the config. The levers, in order: enable FlashBoot; raise the idle timeout so warm workers linger between bursts; set a nonzero min-worker to keep capacity warm (state that a min-worker bills around the clock; it is an always-on worker); move the model load off the boot with model caching (network volume, Runpod's model repository, or weights baked into the image); and make sure the scaler isn't scaling to zero between every request. Name the levers and their cost before touching anything.
- **Load-balancer endpoint, workers never ready.** On a load-balancer (custom-HTTP) endpoint the load balancer decides readiness by polling the worker's health endpoint: `HEALTH_CHECK_PATH` (default `/ping`) on `PORT_HEALTH` (default 80), which is separate from the serving `PORT` (default 80). Workers stuck un-ready while requests arrive usually means nothing answers that path on that port; the endpoint read gives you the exact health URL being polled. The fix is a redeploy that exposes the port and serves the health path (see `serverless-deploy`), not a scaler change.

End phase 1 with the diagnosis and the *recommended* change, but do not apply it unless the prompt authorized a change. If the ask was only "why / what's wrong", you are done here.

## Phase 2 — tune safely (only if the user authorized a change)

Advance only when the prompt asks to change a *named* endpoint's setting.

- **The read-back invariant.** Read the endpoint's full config first, so you hold the before values. Apply the change as a PATCH carrying only the fields the user authorized. Sending fields you were not asked about is how you overwrite a setting they tuned by hand. Then read the config back and confirm the target field holds its new value and the neighbours you quoted are unchanged.
- **Autoscaling tune, bursty traffic.** For bursty workloads, tune the scaler and worker band: raise max workers for the burst ceiling, set the queue-delay or request-count scaler target to how fast you want to absorb the burst, and set idle timeout to how long to hold warm workers between waves (a queue endpoint scaling on request count rejects `workers.idleTimeout`, and the account's worker quota can refuse a higher `workers.max`). Change only the fields the user agreed; state the cost of a higher min-worker.
- **Pin to one GPU type.** When the user wants the endpoint locked to one exact card, select the pool that contains the card and list the pool's other GPU types in `gpu.excludedTypes` (at least one type must remain), with the CUDA floor if given. `set-endpoint-gpus` builds that exclusion list for you and re-sends the endpoint's other settings unchanged; `update-endpoint` can carry the same `gpu` object, but there `pools` and `excludedTypes` are one selection, so send both together. `allowedCudaVersions` and `minCudaVersion` are mutually exclusive (400 if both are sent). Changing the CUDA constraint or the pool does not evict running workers; bounce `workers.max` to 0 and back when the change must apply now. Read the endpoint back after a pin and confirm the scaling settings survived.

## Phase 3 — manage the queue (gated actions)

- **Cancel one job.** When the user names a job to cancel, cancel that job by id. Cancel affects only queued/in-progress jobs. After the cancel, VERIFY with a fresh `get-job-status` read. The cancel call's own response is not verification (an unread write is an unverified write); the final answer reports the re-read state. If the re-read shows the job already reached a terminal state before your cancel, say exactly that; it is a complete, honest outcome.
- **Purge the queue.** When the user wants every pending job cleared, purge the queue. This removes *all* pending jobs; in-progress jobs keep running. Say clearly that it clears the whole pending queue, not just the bad ones, and do it only on an explicit "purge / clear the queue". Re-read health afterward to confirm the queue drained.

## Hard rules

- Every settings change is read → update → read: (1) read the current config, (2) apply the update, (3) a FRESH `get-endpoint` read AFTER it. The before/after values the final answer quotes come from reads (1) and (3). The update call's own response is not a read; never claim a read-back you did not perform.
- Change only the setting the user authorized, on the endpoint they named. Never tune, pin, or purge an endpoint the user did not name.
- Diagnosis is read-only, and read-only includes ZERO job submissions. Never fire a `run`/`runsync` "test probe" while diagnosing: a submitted job bills compute and changes the queue, so it is a mutation, and on a broken endpoint it burns money to reproduce what the worker states already show. Diagnose from the endpoint/health/worker/log reads only; a recommended fix is presented, not applied, unless the prompt authorizes it.
- A queue purge clears the entire pending queue. Say so before doing it; never purge on a vague "clean this up".
- State the cost of any setting that bills continuously (a nonzero min-worker keeps workers warm and billed) before applying it.
- Quote the health/worker/log field you read. No "probably" about a number the tool returns.
- Never cancel or purge jobs the user did not ask you to; do not "helpfully" clear a queue during a diagnosis.
- If a read (health, workers, logs) fails, report it and stop; do not guess the cause.

## Error handling

- A setting nobody touched comes back changed → it was not the PATCH, which leaves omitted fields untouched (except `gpu.pools` sent without `excludedTypes`, which clears the exclusions). Look at the other write paths: a GPU pin that re-sent the whole config, a template save, a redeploy, or a concurrent change by someone else. Re-read before re-applying anything.
- `IN_QUEUE` with ready workers and nothing in progress → do not wait it out: read the worker logs (`source=system`); a container that exits before the handler runs looks exactly like this and points at a broken image, not at the scaler.
- Worker logs show OOM → the GPU is undersized; the fix is a bigger GPU (re-deploy via `serverless-deploy`), not a scaler tweak.
- Cancel/purge returns success but health still shows queued jobs → re-read after a moment; the queue count settles slightly after the action.
- `get-job-status` answers 404 for a job id that was valid → the job's TTL (24 h from submission by default) expired and removed it; it is not a wrong id.
- A GPU-pin request when `set-endpoint-gpus` is missing from the session → make the same selection through `update-endpoint`, sending `gpu.pools` and `gpu.excludedTypes` together.

## Tool binding

| Capability | Tool |
|---|---|
| List / inspect endpoints | `list-endpoints`, `get-endpoint` |
| Endpoint health | `endpoint-health` |
| List workers (per-worker detail) | `list-endpoint-workers` |
| Read a worker's logs | `stream-worker-logs` (`source=system` for the container lifecycle) |
| GPU stock per data center | `list-gpu-types` / `get-gpu-type` (`include:["AVAILABILITY"]`, `product:["SERVERLESS"]`) |
| CUDA versions with capacity, per GPU type | the same read (`cudaVersions`); `get-capacity` for the matrix view |
| Update endpoint settings | `update-endpoint` (PATCH; send `gpu.pools` and `gpu.excludedTypes` together) |
| Pin GPUs / set GPU count | `set-endpoint-gpus` |
| Release history | `list-endpoint-releases` |
| Cancel one job | `cancel-job` |
| Purge the queue | `purge-endpoint-queue` |
| Submit / poll a job | `run-endpoint`, `get-job-status`, `runsync-endpoint` |

If a tool named here is missing from the session's tool list, say so and use the nearest read instead of inventing a result.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey. If the `runpod` router skill has not been loaded in this conversation, load it now, before the next tool call: its rules on which resources you may change, when a request is the go, and when to stop for the user are not repeated here.
