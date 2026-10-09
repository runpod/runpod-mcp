---
name: pod-deploy
description: >-
  Provision a Runpod Pod for interactive, development or training use and tell the user exactly how to connect
  to it. Reads stock before creating, picks the image and GPU class from the catalog reads, exposes only the
  ports the workload needs, hands back the working proxy URL or SSH address, and for training co-locates a
  network volume so checkpoints outlive the Pod. Also covers creating a Pod and stopping it immediately, so that
  only its disk bills until the user comes back. Use when the user wants a GPU or CPU machine of their own (a
  web app, Jupyter, SSH, a training box) rather than a Serverless endpoint, through the Runpod MCP tools.
metadata:
  concepts: [pod, template, gpu-type, gpu-availability, data-center, cloud-tier, exposed-port, container-disk, pod-volume-disk, network-volume]
---

# Pod deploy

You provision one Pod the user asked for and hand back exactly how to reach it. Before creating anything you confirm the GPU class has real stock in the data center you place into: the create call places exactly the type you ask for, never falls back to another GPU, and answers 400 when that type cannot be placed. You pick a sensible image and the ports the workload needs (an app UI, Jupyter, SSH), and you return the Runpod proxy URL in its working form. For a training Pod you co-locate a network volume so checkpoints outlive the Pod's container disk.

Creating a Pod is billable. State the hourly cost before you create it. Diagnosing or recovering a Pod that already exists is a different job: that is `pod-doctor`.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the tool binding below. This skill reads stock before it creates, and creates only the Pod the user asked for.

- Read GPU stock per data center, with the CUDA versions that have capacity when a CUDA floor matters: confirm the class is available before creating (delegate the fuller catalog read to `discovery`).
- Create a network volume: checkpoint durability for training (delegate the CRUD hygiene to `lifecycle-crud`).
- Create a Pod (image, GPU or CPU, disk, ports, env, data center, mounts).
- Inspect a Pod: read back its status, exposed ports, and the proxy/public address.
- List Pods: resolve "which Pod" and confirm what already exists.
- Read a Pod's boot logs: confirm the app came up on the port before handing back a URL.
- Stop / terminate a Pod: create-then-pause, and cleanup when the user asks for it.

## Phase 1 — confirm stock and shape the Pod

- Read GPU availability for the class the workload needs before creating. `include:["AVAILABILITY"]` together with `product:["POD"]` (the two go together, and stock differs by product) carries the per-data-center picture, so the data center you place into is read, not assumed. If the class has no stock there, say so and offer another class or data center; do not create into an unavailable class.
- Pick the image for the use: an interactive app (e.g. a ComfyUI or PyTorch image) for dev, a CUDA/PyTorch base for training. Match the image's CUDA to what the GPU class supports, and pin it as a floor on the create: `gpu.minCudaVersion` at the image's CUDA line (12.8 for a CUDA 12 image; 13.0 only for an image built on CUDA 13), so the Pod lands on a host whose driver supports the image. A template's `allowedCudaVersions` seeds the floor; an explicit `gpu` field on the create replaces the seed, and the availability read's `cudaVersions` says whether that floor has stock.
- **The image comes from this session's reads, not memory.** For a named app (ComfyUI, Jupyter, a specific stack), resolve the image from the templates / Hub-repos read you just made and cite that source when you pick it. An image already running on the account (visible in a `list-pods` read) is also a session-read source worth checking when the catalog comes up empty; cite the pod you saw it on. Only when the catalog has no match may you fall back to a well-known public image, and then say so explicitly in the answer. A from-memory image tag is how you get a stale image that crash-loops on boot. Runpod publishes no `:latest` tags, so pin an exact tag; for GPU work prefer the `runpod/pytorch` images over `runpod/base`.
- Decide the ports from the workload: the app's own port over HTTP for a web UI, `8888/http` for Jupyter, `22/tcp` for direct SSH. SSH also needs `startSsh: true` at create and a key registered on the account (check `get-ssh-keys` first); without both the Pod has no SSH access whatever its ports. Only expose what the user needs to reach.
- **State the cost.** Quote the GPU's hourly rate from the catalog read before creating. A running Pod bills whether or not the user is using it.

## Phase 2 — create and connect

- **Interactive / dev Pod.** Create the Pod with the chosen image, GPU class, disk, ports, and data center. After it reaches running, inspect it and read back the exposed ports and the live mappings. The Pod's `runtime.ports` stay empty while the container initializes, so poll until they are populated before handing back a URL. App images are large and can take minutes to pull. A slow boot is NOT a failure: never create a second Pod because the first is still pulling. State the proxy URL form (`https://<podId>-<port>.proxy.runpod.net`) as soon as the Pod id exists. If the app has not bound after the waits your tools can hold, deliver the evidenced status report (pod id, state, last log line) and the recommended next step; offering to keep watching is fine. The reachable form for an HTTP port is the proxy URL `https://<podId>-<port>.proxy.runpod.net`. For SSH, hand back the Pod's `ssh` block: `ssh.direct` (needs `22/tcp`; full SSH including scp and rsync) or, on a machine with no public IP, `ssh.proxy` (interactive shell only). `ssh.direct` can appear minutes after RUNNING and changes on every stop/start, so say so when it is missing. Confirm the app bound (read the boot log for the "listening on 0.0.0.0:PORT" line) before telling the user it is reachable.
- **Create then stop for later.** When the user wants the Pod created but not running yet, create it, confirm it reached running, then STOP it. Never terminate: terminate deletes the volume disk the user wants to keep. After the stop, state the consequences: compute billing ends and the GPU is released; the stop clears the container disk, while the volume disk (`/workspace` by default) survives and bills at the stopped-disk rate until the Pod is terminated; the Pod stays on its machine and resumes there, so if another renter takes that GPU in the meantime a start can be refused for lack of a free GPU on that host, or come back without one; anything on a network volume is unaffected. Tell the user how to resume (start the Pod) and what to do if the GPU is gone: wait and retry, start with zero GPUs to reach the files, or migrate the Pod from the console (`pod-doctor` covers that).
- **Training Pod with durable checkpoints.** Checkpoints written to container disk die with the Pod, so co-locate a network volume. Create the volume in the same data center you will place the Pod (see `lifecycle-crud`; network volumes attach to Secure Cloud Pods only, so the Pod goes to Secure Cloud). Then create the Pod with that volume mounted at a checkpoint path (e.g. `/workspace` or `/checkpoints`) and pin the Pod to that data center. Tell the user the mount path and that checkpoints there survive the Pod being stopped or terminated, while container disk does not. Size the volume to the expected checkpoint total with headroom. On a Pod the mount path is the one you set in `mounts` (no default); a Serverless worker always sees the volume at `/runpod-volume`. If these checkpoints will later be read by a serverless endpoint, its handler must read them at `/runpod-volume`, not the pod path.

## Phase 3 — hand back

- The hand-back lives in your FINAL message and stands alone (router contract). It carries the Pod id, the exact image it runs and which template/Hub read it came from, the GPU class WITH the stock evidence that justified it (quote the availability read: "RTX 3090 — N available in EU-RO-1"), the reachable URL(s) verbatim (the full proxy URL for HTTP, the `ssh` connect string for SSH; never "the link above", and never the boot log's internal `0.0.0.0:<port>` address, which is not a reachable URL) with the note that a proxy URL is public and unauthenticated by default (anything sensitive behind it needs its own authentication), the mount path if a volume was attached, and the Pod's state with the hourly cost that is now running. For a stopped Pod, always include the billing consequence with the state: GPU billing ended, the volume disk bills at the stopped rate until the Pod is terminated, and a network volume bills from creation until it is deleted whatever the Pod does.
- **Cleanup.** The default is to keep the Pod the user asked for and tell them what is billing and how to stop it (stop keeps the volume disk and bills it at the stopped rate; terminate deletes the volume disk; a network volume survives either and bills until it is deleted). Tear down (and delete any volume created only for the exercise) only when the user framed the journey as a throwaway test or asks for cleanup, confirming by a read-back. When the user framed the Pod as a trial to be removed once it runs, the proof is your own reads: the Pod RUNNING with its port mapped, and the app's listening line in the boot log. Once you have both, terminate the Pod in the same turn, confirm by a read that it is gone, and report the proof you saw. Do not end the turn waiting for the user to try the URL.

## Hard rules

- Confirm stock before creating. Never create into a GPU class with no availability.
- State the hourly cost before creating any Pod, and before creating a network volume.
- Create only the Pod the user asked for. Never stop, terminate, or modify a Pod (or volume) the user did not name.
- Do not hand back a proxy URL until the Pod is fully running and the app has bound to the port. Empty `runtime.ports` mean it is still initializing, not broken.
- For training, checkpoints must land on a network volume, not container disk; otherwise a stop/terminate loses them.
- Expose only the ports the workload needs. Do not open SSH (`22/tcp`, `startSsh`) or extra ports the user did not ask for.
- Never claim a Pod is reachable on the create call alone; read back its state first.

## Error handling

- Create returns `400` with a placement or stock error → the class ran out in that data center between the read and the create; surface it and offer another class or data center rather than retrying the same one. The same 400 ("no instances available") also answers an invalid GPU type id; check the id against the catalog read before calling it a stock-out.
- The Pod reaches running but `runtime.ports` is still empty → it is still initializing; poll `get-pod` until it is populated before handing back a URL. This is normal Runpod API behavior, not a failure.
- The proxy URL 502s right after create → the app inside has not bound to the port yet, or bound to `127.0.0.1` instead of `0.0.0.0`; read the boot log to confirm before declaring the Pod broken (deeper diagnosis is `pod-doctor`).
- `create-network-volume` is refused → read the error: the data center may not offer network storage (an empty `networkVolumeTypes` on the data-center read), the size may be outside 10–4096 GB, or the account balance may be too low; tell the user the exact reason and stop.
- A create call fails → report it and stop; do not retry blindly or create a second Pod.
- The Pod is running but the app is still pulling/booting after minutes → that is normal for multi-GB images, not grounds for a replacement Pod or an open-ended wait; follow the bounded-wait hand-back above.

## Report template — pod hand-back

A good pod hand-back leads with four lines, each filled from a read made this
turn: the Pod (id, state, hourly rate while running); the image (which
template, Hub or pod read it came from); the GPU class with the stock figure
from the availability read; and the reachable URL in its proxy form (or
the `ssh` connect string for SSH). Then the mount path if a volume was attached, and the
billing consequence of the Pod's current state.

## Tool binding

| Capability | Tool |
|---|---|
| GPU stock per data center | `list-gpu-types` / `get-gpu-type` (`include:["AVAILABILITY"]`, `product:["POD"]`) |
| CUDA versions with capacity, per GPU type | the same read (`cudaVersions`); `get-capacity` for the matrix view across host CUDA versions |
| Data centers | `list-data-centers`, `get-data-center` |
| Create a network volume | `create-network-volume` |
| Create a Pod | `create-pod` |
| Inspect a Pod | `get-pod` |
| List Pods | `list-pods` |
| Read Pod boot logs | `stream-pod-logs` |
| Stop a Pod (keep the volume disk) | `pod-action` (`{"action":"stop"}`) |
| Resume a stopped Pod | `pod-action` (`{"action":"start"}`) |
| Terminate a Pod | `delete-pod` |
| Account SSH keys | `get-ssh-keys` / `update-ssh-keys` |

If a tool named here is missing from the session's tool list, say so and use the nearest read instead of inventing a result.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey. If the `runpod` router skill has not been loaded in this conversation, load it now, before the next tool call: its rules on which resources you may change, when a request is the go, and when to stop for the user are not repeated here.
