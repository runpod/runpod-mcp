---
name: pod-doctor
description: >-
  Diagnose a Runpod Pod that is unreachable, GPU-blind or stuck, and perform a recovery action only when the
  user authorizes one. Use when an existing Pod misbehaves, through the Runpod MCP tools: its proxy URL answers 502, CUDA is not available
  inside the container, a restarted Pod has no GPU, the user wants a Pod's logs read, an account-wide check for
  stuck Pods, or the stop-versus-terminate decision for a Pod they already have. Read-only until the user asks
  for an action.
metadata:
  concepts: [pod, machine, container-disk, pod-volume-disk, exposed-port, log-stream, gpu-availability, pod-migration]
---

# Pod doctor

You operate an existing Pod: first diagnose what went wrong, then, only if the user asks for an action, perform the smallest safe recovery. Diagnosis is always read-only: no `update-pod`, `pod-action`, `delete-pod` or `create-pod` while diagnosing, whatever the logs suggest. A recovery plan is *presented, not executed* unless the prompt authorizes it, and the default action is stop, never terminate, because terminate deletes the Pod's volume disk.

Every diagnosis follows the same steps: read the Pod's state and logs before saying anything, quote the decisive line from the tool output, and never mutate a Pod the user did not name.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the tool binding below. This skill reads before it acts.

- List Pods: the account-wide stuck audit and the "which Pod" resolution.
- Inspect one Pod: full status, ports, GPU count, mounts.
- Read a Pod's boot/container logs: the model-load and crash evidence.
- Trigger a Pod state transition (stop / start / restart): the gated action.
- Terminate a Pod: the destructive transition, gated separately.
- Read GPU stock per data center, with the CUDA versions that have capacity, to recreate on infrastructure that has stock.
- Recreate a Pod, only inside an authorized recovery.

## Phase 1 — diagnose (always, read-only)

Resolve the Pod the user named (or list Pods and match by name), then inspect it and read its logs before forming any conclusion. Classify against the symptom:

- **Proxy 502 / "can't reach the web UI".** Inspect the Pod. If its `status` is not `RUNNING`, that is the cause: the proxy has nothing to route to. If it is running, read the logs: a 502 through `<podId>-<port>.proxy.runpod.net` almost always means the app inside is bound to `127.0.0.1` (must bind `0.0.0.0`), listening on a port the Pod never exposed, still starting, or never started at all (no process on the exposed port). Quote the bind/listen line. The exposed ports are on the Pod record; name the mismatch, do not guess. A `524` is different: the proxy closes requests that run longer than 100 s, so it means a long request, not a dead app. For an app that never started, the answer is the diagnosis plus the exact change the user would apply (the start command, the env, the restart), marked "not applied".
- **`torch.cuda.is_available()` is False.** Inspect the Pod record's `gpu` block, which carries the GPU count. If the block is absent or its count is 0, treat the Pod as CPU-only: this is a zero-GPU allocation, not a CUDA problem; go to the next classifier. If it shows one or more GPUs, the GPU is attached but the container can't use it: read the logs for the driver/runtime line. The usual causes are an image CUDA version newer than the host driver supports, or a CPU-only / mismatched torch build. Quote the line; do not assert which without it.
- **No GPU after a restart.** A stopped Pod releases its GPU but stays bound to its machine and resumes there. If another renter took that machine's GPU in the meantime, a plain start is refused for lack of a free GPU on that host, or the Pod comes back `RUNNING` without a GPU. Confirm it from the Pod record (the `gpu` block absent or its count 0, so the Pod is CPU-only) and say what it means: the GPU on that one machine is taken. Data-center stock for the GPU type does not predict whether this Pod gets its GPU back, so quote availability only when proposing a fresh Pod elsewhere. This is a placement problem, not a broken Pod. Give the user the concrete recoveries, not only a retry: (1) retry start until that machine's GPU frees; (2) migrate the Pod from the console, or recreate it on a GPU type or data center with live stock (a migrated or recreated Pod gets a new id and proxy URL); (3) **data rescue from a zero-GPU pod**: a pod started with 0 GPUs still runs and serves its filesystem, so the files are reachable with no GPU attached. No MCP tool moves bytes, so name the real path for the copy itself and hand it to the user: `runpodctl send` / `runpodctl receive`, `aws s3` against a network volume's S3 endpoint, or `scp`/`rsync` over the Pod's direct SSH (`ssh.direct`) (see `api-boundary`). Never claim the rescue needs a GPU first, and never claim to have copied anything yourself. Never terminate; that deletes the volume disk.
- **Read the logs for a load or startup answer.** Read the Pod's logs with a generous tail (`source=system` for the pull, create and start events when the Pod is stuck in `STARTING`). Quote the single decisive line: the weights-loaded / "running on 0.0.0.0:PORT" success line, or the OOM / missing-file / auth failure. Report what the log says, never what it probably says.
- **Account-wide stuck audit.** List all Pods. Flag as stuck: `status=RUNNING` with no GPU (the Pod record's `gpu` block absent or its count 0); or stuck in `PROVISIONING`/`STARTING` past about 10 minutes with no pull progress in the system log (a 20 GB image legitimately takes 10 to 15 minutes to pull). Present one table (name, requested GPU, status, stuck-for, reason). If nothing is stuck, say so in one line and stop. The counts in the summary must equal the rows in the table.

**No RUNNING pod resolves (empty account, all pods stopped/exited, or wrong key).** If `list-pods` returns nothing, or returns only stopped/EXITED pods none of which matches a live session the user describes, do not stop at "give me a pod ID" or "which pod did you mean". State what the list shows (no pods, or only stopped ones, by name) and the likely reason (stopped since the symptom, a different account/key, or the pod was terminated). **Then commit to the most-common cause of that symptom and its concrete fix as the usual explanation**, and where the account/key mismatch is a live possibility, ask which account they are on as the one follow-up:
- Zero GPUs after restart → the usual cause is that another renter took the GPU on the machine the stopped Pod is bound to; recovery is to resume the Pod even at 0 GPUs so its files are reachable for a copy off (the copy runs through runpodctl or a volume's S3 endpoint; no MCP tool moves bytes), retry-start until that GPU frees, or migrate or recreate onto a machine with stock. Never terminate, which deletes the volume disk.
- `torch.cuda.is_available()` False → the usual cause is the image's CUDA version being newer than the host driver (or a CPU-only/mismatched torch build); the host driver cannot change from inside the container, so the fix is to redeploy/recreate with a CUDA-version constraint (or a matching torch build).

End phase 1 with the diagnosis and, if a fix exists, the *recommended* action, but do not run it. If the prompt was only "why / what's wrong / is anything stuck", you are done here.

## Phase 2 — recovery (only if the user authorized an action)

Advance only when the prompt explicitly asks to stop, restart, recreate, or terminate a *named* Pod. A locked Pod refuses stop, terminate, edit and reset and keeps billing; the unlock is the user's step in the console.

- **Stop vs terminate.** State the consequence before acting, every time: **stop** releases GPU/CPU compute, moves the Pod to `EXITED`, clears the container disk, and keeps the volume disk (`/workspace` by default), billed at the stopped-disk rate; stop is reversible with start, on the same machine. **Terminate** permanently deletes the Pod and its volume disk (a network volume is only detached, not deleted). When the user wants to stop paying for compute and keep the files, the answer is stop. Only terminate on an explicit "delete / terminate / throw it away", and say what disk dies.
- **Restart / re-acquire.** For a zero-GPU or hung Pod the user asked to recover, prefer stop→start (or restart) before any recreate; it is cheaper and non-destructive.
- **Recreate on alternative infra.** Only if the user authorized a recreate. Capture the original config (image, GPU class, disk, ports, env, mounts, DC) from the Pod record and pick a GPU type and data center with real stock from the availability read. Rescue anything on the volume disk first (terminate deletes it) and quote the log lines you need before terminating (a terminated Pod's logs are gone), then terminate + create. State the new Pod's hourly cost before creating it; a recreate is a billable resource. Never recreate a Pod whose original `image` is unavailable; skip and say so.

## Hard rules

- Never stop, restart, terminate, or recreate a Pod the user did not name. A stuck Pod may still hold state the user wants.
- Default to stop. Terminate only on an explicit destructive instruction, and always after naming the disk that dies.
- State the hourly cost before creating or recreating any Pod.
- Never claim a recreate succeeded on the create call alone: a fresh Pod is created, not yet known healthy. Ask the user to re-run diagnosis to confirm.
- Diagnosis quotes the log/field it read. No "probably" about a fact the tool can answer.
- If a log read or inspect call fails, report the failure and stop; do not guess the cause.

## Error handling

- A terminate/delete returns `204` with no body. That is success, not an error.
- A state-transition request that is invalid for the Pod's current status returns `409`. The Pod record's `actions` lists the permitted transitions; read it and pick a valid one.
- A recreate that returns `no gpu available` means the chosen GPU/DC also has no stock right now. Surface it and stop; do not silently retry elsewhere.

## Tool binding

| Capability | Tool |
|---|---|
| List Pods | `list-pods` |
| Inspect one Pod | `get-pod` |
| Read Pod boot/container logs | `stream-pod-logs` (`source=system` for lifecycle events) |
| Stop a Pod (keep the volume disk) | `pod-action` (`{"action":"stop"}`) |
| Terminate a Pod | `delete-pod` (or `pod-action` `{"action":"terminate"}`) |
| Restart / start a Pod | `pod-action` (`{"action":"restart"}` / `"start"`) |
| GPU stock per data center | `list-gpu-types` / `get-gpu-type` (`include:["AVAILABILITY"]`, `product:["POD"]`) |
| CUDA versions with capacity, per GPU type | the same read (`cudaVersions`); `get-capacity` for the matrix view |
| Data centers | `list-data-centers` |
| Recreate a Pod | `create-pod` |

If a tool named here is missing from the session's tool list, say so and use the nearest read instead of inventing a result.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey. If the `runpod` router skill has not been loaded in this conversation, load it now, before the next tool call: its rules on which resources you may change, when a request is the go, and when to stop for the user are not repeated here.
