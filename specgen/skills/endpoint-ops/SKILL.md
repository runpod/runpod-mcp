---
name: endpoint-ops
description: Operate a Serverless endpoint that already exists — diagnose stuck jobs and dying workers, tune its scaling and cold-start settings safely, and manage its queue. Read-only by default; mutates only the exact setting the user authorized. Trigger on phrases like "my jobs are stuck IN_QUEUE", "the video job never runs", "cold starts are killing my chatbot", "pin my endpoint to a validated GPU", "tune autoscaling for bursty traffic", "my caption workers keep dying", "cancel this job", "purge the queue / clear a bad batch".
---

# Endpoint ops

You operate a Serverless endpoint that already exists. Everything starts by reading its current state — the endpoint config, its health, its workers, its logs — before you say anything or change anything. Diagnosis is always read-only. You change a setting only when the user asked for a change, and then only the exact setting agreed.

One property of the RunPod update path drives the central rule here: an endpoint update is a genuine PATCH — only the fields present in the body change, and omitted fields are left untouched — so you send exactly the setting you were asked to change and nothing else. What the PATCH does not give you is proof: its own response is not a read. Read the config first for the before value, and read it back afterward for the after value. (The GPU-pin path behaves differently — see phase 2.)

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the per-server tool binding below. This skill reads before it mutates, and mutates only what the user authorized.

- List and inspect endpoints — resolve "which endpoint" and read the full current config.
- Read endpoint health and list workers — the stuck-queue / dying-worker evidence.
- Read a worker's logs — the crash / model-load failure line.
- Read GPU stock per data center, and the capacity matrix across host CUDA versions — is a stuck queue a capacity problem.
- Update an endpoint (worker min/max, idle timeout, scaler, FlashBoot, disk, env) — the gated tune.
- Pin GPUs / set GPU count — the validated-card pin the plain update can't express.
- Read release history — which build the workers are running.
- Cancel one job; purge the queue — the queue-management actions, each gated.
- Submit and poll a job — to re-verify after a change.

## Phase 1 — diagnose (always, read-only)

Resolve the endpoint (list endpoints and match by name if needed), read its config, then read health and workers before forming a conclusion. Classify against the symptom:

- **Jobs stuck `IN_QUEUE`.** Read health and the worker list. If max workers is 0 or all workers are throttled/unhealthy, the queue has nothing to run on. Separate the causes: worker **limit** (max-workers too low, or min 0 with a cold scaler) vs **capacity** (workers can't acquire the pinned GPU — cross-check that GPU type's per-data-center availability, and the CUDA-version matrix when the endpoint pins a CUDA floor) vs **unhealthy** (workers cycling — read their logs). Name which one, quoting the health/worker numbers you read.
- **Workers crash-looping.** List workers, find the failing ones, read their logs, and quote the decisive line — a missing model file, a gated 403, an OOM, a bad handler import. Report what the log says, not a guess. OOM → the GPU is undersized for the real memory pattern; a load/import error → the image or env is wrong.
- **Cold starts hurt.** Read the config. The real levers, in order: enable FlashBoot; raise the idle timeout so warm workers linger between bursts; set a nonzero min-worker to keep capacity warm (state that a min-worker bills around the clock — it is an always-on worker); and make sure the scaler isn't scaling to zero between every request. Name the levers and their cost before touching anything.
- **Load-balancer endpoint, workers never ready.** On a load-balancer (custom-HTTP) endpoint the load balancer decides readiness by polling the worker's health endpoint — the path from the worker's `HEALTH_CHECK_PATH` env, or `/ping` when that is unset — over the HTTP port the template exposes. Workers stuck un-ready while jobs arrive usually means the port is not exposed or nothing answers that path; the endpoint read gives you the exact health URL being polled. The fix is a redeploy that exposes the port and serves the health path (see `serverless-deploy`), not a scaler change.

End phase 1 with the diagnosis and the *recommended* change — but do not apply it unless the prompt authorized a change. If the ask was purely "why / what's wrong", you are done here.

## Phase 2 — tune safely (only if the user authorized a change)

Advance only when the prompt asks to change a *named* endpoint's setting.

- **The read-back invariant.** Read the endpoint's full config first, so you hold the before values. Apply the change as a PATCH carrying only the fields the user authorized — sending fields you were not asked about is how you overwrite a setting they tuned by hand. Then read the config back and confirm the target field holds its new value and the neighbours you quoted are unchanged.
- **Autoscaling tune, bursty traffic.** For bursty workloads (e.g. transcription that arrives in waves), tune the scaler and worker band: raise max workers for the burst ceiling, set the queue-delay or request-count scaler target to how fast you want to absorb the burst, and set idle timeout to how long to hold warm workers between waves. Change only the fields the user agreed; state the cost of a higher min-worker.
- **Pin to a validated GPU.** When the user wants the endpoint locked to a card they validated, pin the GPU SKU / pools (and CUDA floor if given). This is the SKU pin the plain update path can't express; if the connected server has no GPU-pin tool, say so — pinning a specific SKU is not available there. Unlike the REST PATCH, the pin goes through the GraphQL `saveEndpoint` mutation, which is **not** a sparse update: a save that omits fields resets them (workersMax, idleTimeout, scalerValue) to server defaults, which is why the pin tool re-sends the endpoint's whole config. Read the endpoint back after a pin and confirm the scaling settings survived.

## Phase 3 — manage the queue (gated actions)

- **Cancel one job.** When the user names a job to cancel, cancel that job by id. Cancel affects only queued/in-progress jobs. After the cancel, VERIFY with a fresh `get-job-status` read — the cancel call's own response is not verification (an unread write is an unverified write); the final answer reports the re-read state. If the re-read shows the job already reached a terminal state before your cancel, say exactly that — it is a complete, honest outcome.
- **Purge a bad batch.** When the user wants to clear a queue of bad/erroneous jobs, purge the queue — this removes *all* pending jobs; in-progress jobs keep running. Say clearly that it clears the whole pending queue, not just the bad ones, and do it only on an explicit "purge / clear the queue". Re-read health afterward to confirm the queue drained.

## Hard rules

- Every settings change is read → update → read: (1) read the current config, (2) apply the update, (3) a FRESH `get-endpoint` read AFTER it. The before/after values the final answer quotes come from reads (1) and (3) — the update call's own response is not a read, and never claim a read-back you did not actually perform.
- Change only the setting the user authorized, on the endpoint they named. Never tune, pin, or purge an endpoint the user did not name.
- Diagnosis is read-only — and read-only includes ZERO job submissions: never fire a `run`/`runsync` "test probe" while diagnosing (a submitted job bills compute and changes the queue — it is a mutation, and on a broken endpoint it burns money to reproduce what the worker states already show). Diagnose from the endpoint/health/worker/log reads only; a recommended fix is presented, not applied, unless the prompt authorizes it.
- A queue purge clears the entire pending queue — say so before doing it; never purge on a vague "clean this up".
- State the cost of any setting that bills continuously (a nonzero min-worker keeps workers warm and billed) before applying it.
- Quote the health/worker/log field you read. No "probably" about a number the tool returns.
- Never cancel or purge jobs the user did not ask you to; do not "helpfully" clear a queue during a diagnosis.
- If a read (health, workers, logs) fails, report it and stop; do not guess the cause.

## Error handling

- A setting nobody touched comes back changed → it was not the PATCH, which leaves omitted fields untouched; look at the other write paths — a GPU pin (GraphQL `saveEndpoint`, a whole-config save), a redeploy, or a concurrent change by someone else. Re-read before re-applying anything.
- `IN_QUEUE` with healthy workers and free capacity → the scaler hasn't spun a worker yet; give it a moment and re-read health rather than force-changing settings.
- Worker logs show OOM → the GPU is undersized; the fix is a bigger GPU (re-deploy via `serverless-deploy`), not a scaler tweak.
- Cancel/purge returns success but health still shows queued jobs → re-read after a moment; the queue count settles slightly after the action.
- A GPU-pin request on a server without the pin tool → say SKU pinning is not available on this server; offer the pool-level constraint the update path can express instead.

## Per-server tool binding

| Capability | This server | Official `runpod-mcp` |
|---|---|---|
| List / inspect endpoints | `list-endpoints`, `get-endpoint` | `get-endpoint` |
| Endpoint health | `endpoint-health` | `endpoint-health` |
| List workers (per-worker detail) | `list-endpoint-workers` | *(coarse — `endpoint-health` only)* |
| Read a worker's logs | `stream-worker-logs` | *(unbound — no REST log stream)* |
| GPU stock per data center | `list-gpu-types` (`include:["AVAILABILITY"]`), `get-gpu-type` | `list-gpu-types` |
| Capacity matrix (per host CUDA version) | `get-capacity` | *(unbound — GraphQL-only)* |
| Update endpoint settings | `update-endpoint` | `update-endpoint` |
| Pin GPUs / set GPU count | `set-endpoint-gpus` | *(unbound — no SKU pin)* |
| Release history | `list-endpoint-releases` | *(unbound)* |
| Cancel one job | `cancel-job` | *(varies)* |
| Purge the queue | `purge-endpoint-queue` | *(varies)* |
| Submit / poll a job | `runsync-endpoint`, `run-endpoint`, `get-job-status` | `runsync-endpoint` |

Where a capability is unbound on a server, say "not available on this server" and work with what the server does offer.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey.
