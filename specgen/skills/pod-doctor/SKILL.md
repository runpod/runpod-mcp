---
name: pod-doctor
description: Diagnose a Runpod Pod that is unreachable, GPU-blind, or stuck, then perform a recovery action only if the user authorizes one. Trigger on phrases like "pod 502", "can't reach my pod", "torch can't see the GPU", "cuda not available", "pod came back with no gpu", "did my model load", "read my pod logs", "is anything stuck on my account", "stop vs terminate my pod".
---

# Pod doctor

You operate an existing Pod: first diagnose what went wrong, then — only if the user asks for an action — perform the smallest safe recovery. Diagnosis is always read-only. A recovery plan is *presented, not executed* unless the prompt authorizes it, and the default action is stop, never terminate, because terminate destroys container-disk state.

The spine is always the same: read the Pod's state and logs before saying anything, quote the decisive line from the tool output, and never mutate a Pod the user did not name.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the per-server tool binding below. This skill reads before it acts.

- List Pods with machine info — the account-wide stuck audit and the "which Pod" resolution.
- Inspect one Pod — full status, ports, GPU count, mounts.
- Read a Pod's boot/container logs — the model-load and crash evidence.
- Trigger a Pod state transition (stop / start / restart) — the gated action.
- Terminate a Pod — the destructive transition, gated separately.
- Read GPU stock per data center, and the capacity matrix across host CUDA versions — to recreate on infra that actually has stock.
- Recreate a Pod — only inside an authorized recovery.

## Phase 1 — diagnose (always, read-only)

Resolve the Pod the user named (or list Pods and match by name), then inspect it and read its logs before forming any conclusion. Classify against the symptom:

- **Proxy 502 / "can't reach the web UI".** Inspect the Pod. If its `status` is not `RUNNING`, that is the cause — the proxy has nothing to route to. If it is running, read the logs: a 502 through `<podId>-<port>.proxy.runpod.net` almost always means the app inside is bound to `127.0.0.1` (must bind `0.0.0.0`), listening on a port the Pod never exposed, or still starting. Quote the bind/listen line. The exposed ports are on the Pod record — name the mismatch, do not guess.
- **`torch.cuda.is_available()` is False.** Inspect the Pod's GPU count (`gpuCount` on the pod record). If it is `0`, this is a zero-GPU allocation, not a CUDA problem — go to the next classifier. If it is `>=1`, the GPU is attached but the container can't use it: read the logs for the driver/runtime line. The usual causes are an image CUDA version newer than the host driver supports, or a CPU-only / mismatched torch build. Quote the line; do not assert which without it.
- **"Pod came back with zero GPUs" after a restart.** A stopped Pod releases its GPU compute (that is what stop does — see phase 2). On start it must re-acquire a GPU from live stock, and if none is free in that DC it can come back `RUNNING` with `gpuCount = 0`. Confirm `gpuCount = 0`, then read that GPU class's per-data-center availability to show whether the shortage in its data center is real. This is a stock problem, not a broken Pod. Give the user the three concrete recoveries, not just a retry lottery: (1) retry start until the type frees; (2) recreate the pod on a GPU type or data center with live stock; (3) **data rescue from a zero-GPU pod** — a pod started with 0 GPUs still runs and serves its filesystem, so the files are reachable with no GPU attached. No MCP tool moves bytes, so name the real path for the copy itself and hand it to the user: `runpodctl send` / `runpodctl receive`, `aws s3` against a network volume's S3 endpoint, or `scp`/`rsync` over the pod's SSH (see `api-boundary`). Never claim the rescue needs a GPU first, and never claim to have copied anything yourself. Never terminate — that destroys the container disk.
- **"Did the model load / read my logs".** Read the Pod's logs with a generous tail. Quote the single decisive line — the weights-loaded / "running on 0.0.0.0:PORT" success line, or the OOM / missing-file / auth failure. Report what the log says, never what it probably says.
- **Account-wide stuck audit.** List all Pods with machine info. Flag as stuck: `status=RUNNING` with a GPU count (`gpuCount`) of 0; or stuck in `PROVISIONING`/`STARTING` past ~10 minutes. Present one table (name, requested GPU, status, stuck-for, reason). If nothing is stuck, say so in one line and stop. Before sending, recount: every number you state ("all N pods", "N stuck") must equal the rows actually printed in your table — a count that contradicts your own table undermines the whole report.

**No RUNNING pod resolves (empty account, all pods stopped/exited, or wrong key).** If `list-pods` returns nothing — or returns only stopped/EXITED pods none of which matches a live session the user describes — do not stop at "give me a pod ID" or "which pod did you mean". State what the list actually shows (no pods, or only stopped ones, by name) and the likely reason (stopped since the symptom, a different account/key, or the pod was terminated), **then commit to the most-common cause of that symptom and its concrete fix as the usual explanation**, and where the account/key mismatch is a live possibility, ask which account they are on as the one follow-up:
- Zero GPUs after restart → the usual cause is that stopping the pod released its GPU to the pool and the restart could not re-acquire that type in that DC; recovery is to resume the pod even at 0 GPUs so its files are reachable for a copy off (the copy runs through runpodctl or a volume's S3 endpoint — no MCP tool moves bytes), retry-start until the type frees, or recreate on a GPU type / DC with stock — and never terminate, which destroys the container disk.
- `torch.cuda.is_available()` False → the usual cause is the image's CUDA version being newer than the host driver (or a CPU-only/mismatched torch build); the host driver cannot change from inside the container, so the fix is to redeploy/recreate with a CUDA-version constraint (or a matching torch build).

End phase 1 with the diagnosis and, if a fix exists, the *recommended* action — but do not run it. If the prompt was purely "why / what's wrong / is anything stuck", you are done here.

## Phase 2 — recovery (only if the user authorized an action)

Advance only when the prompt explicitly asks to stop, restart, recreate, or terminate a *named* Pod.

- **Stop vs terminate.** State the consequence before acting, every time: **stop** releases GPU/CPU compute, keeps the container disk, moves the Pod to `EXITED`, and bills storage only — reversible with start. **Terminate** permanently deletes the Pod; `mounts.persistent` host-local disk is destroyed with it (a `mounts.network` volume is only detached, not deleted). When the user says "stop to avoid paying but keep my data", the answer is stop. Only terminate on an explicit "delete / terminate / throw it away", and say what disk dies.
- **Restart / re-acquire.** For a zero-GPU or hung Pod the user asked to recover, prefer stop→start (or restart) before any recreate — cheaper and non-destructive.
- **Recreate on alternative infra.** Only if the user authorized a recreate. Capture the original config (image, GPU class, disk, ports, env, mounts, DC) from the Pod record, pick a GPU/DC with real stock from the capacity read, then terminate + create. State the new Pod's hourly cost before creating it — a recreate is a billable resource. Never recreate a Pod whose original `image` is unavailable; skip and say so.

## Hard rules

- Never stop, restart, terminate, or recreate a Pod the user did not name. A stuck Pod may still hold state the user wants.
- Default to stop. Terminate only on an explicit destructive instruction, and always after naming the disk that dies.
- State the hourly cost before creating or recreating any Pod.
- Never claim a recreate succeeded on the create call alone — a fresh Pod is created, not yet known healthy. Ask the user to re-run diagnosis to confirm.
- Diagnosis quotes the log/field it read. No "probably" about a fact the tool can answer.
- If a log read or inspect call fails, report the failure and stop — do not guess the cause.

## Error handling

- A terminate/delete returns `204` with no body — that is success, not an error.
- A state-transition request that is invalid for the Pod's current status returns `409` — the permitted actions are on the Pod's `actions` field; read it and pick a valid one.
- A recreate that returns `no gpu available` means the chosen GPU/DC also has no stock right now — surface it and stop, do not silently retry elsewhere.

## Per-server tool binding

| Capability | This server | Official `runpod-mcp` |
|---|---|---|
| List Pods (+ machine info) | `list-pods` | `list-pods` |
| Inspect one Pod | `get-pod` | `get-pod` |
| Read Pod boot/container logs | `stream-pod-logs` | *(unbound — no REST log stream)* |
| Stop a Pod (keep disk) | `pod-action` (`{"action":"stop"}`) | `stop-pod` |
| Terminate a Pod | `delete-pod` (or `pod-action` `{"action":"terminate"}`) | `delete-pod` |
| Restart / start a Pod | `pod-action` (`{"action":"restart"}` / `"start"`) | `start-pod`, `restart-pod` |
| GPU stock per data center | `list-gpu-types` (`include:["AVAILABILITY"]`), `get-gpu-type` | `list-gpu-types` |
| Capacity matrix (per host CUDA version) | `get-capacity` | *(unbound — GraphQL-only)* |
| Data centers | `list-data-centers` | `list-data-centers` |
| Recreate a Pod | `create-pod` | `create-pod` |

Where a capability is unbound on a server, say "not available on this server" and work with what the server does offer.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey.
