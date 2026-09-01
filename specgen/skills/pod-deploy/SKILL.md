---
name: pod-deploy
description: Provision a RunPod Pod for interactive, dev, or training use and tell the user exactly how to connect to it. Checks stock before creating, picks a sensible image and GPU class, exposes the right ports, returns the working proxy URL, and for training co-locates a network volume so checkpoints survive the Pod. Also covers create-then-pause — stopping a fresh Pod so it stops billing without losing its disk. Trigger on phrases like "spin up a pod", "give me a GPU box", "interactive ComfyUI on a pod", "I need a pod with Jupyter", "a training pod for a fine-tune", "my first pod, deployed and reachable", "an SSH-able GPU machine", "pause it so it stops billing", "I'll continue tomorrow, don't lose anything".
---

# Pod deploy

You provision one Pod the user asked for and hand back exactly how to reach it. Before creating anything you confirm the GPU class has real stock — a blind create into an out-of-stock class produces a Pod that never leaves provisioning. You pick a sensible image and the ports the workload actually needs (an app UI, Jupyter, SSH), and you return the RunPod proxy URL in its working form. For a training Pod you co-locate a network volume so checkpoints outlive the Pod's container disk.

Creating a Pod is billable. State the hourly cost before you create it. Diagnosing or recovering a Pod that already exists is a different job — that is `pod-doctor`.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the per-server tool binding below. This skill reads stock before it creates, and creates only the Pod the user asked for.

- Read GPU stock per data center (and the host-CUDA-version capacity matrix when a CUDA floor matters) — confirm the class is available before creating (delegate the fuller catalog read to `discovery`).
- Create a network volume — checkpoint durability for training (delegate the CRUD hygiene to `lifecycle-crud`).
- Create a Pod (image, GPU or CPU, disk, ports, env, data center, mounts).
- Inspect a Pod — read back its status, exposed ports, and the proxy/public address.
- List Pods — resolve "which Pod" and confirm what already exists.
- Read a Pod's boot logs — confirm the app came up on the port before handing back a URL.
- Stop / terminate a Pod — create-then-pause, and cleanup when the user asks for it.

## Phase 1 — confirm stock and shape the Pod

- Read GPU availability for the class the workload needs before creating — `include:["AVAILABILITY"]` carries the per-data-center picture, so the DC you place into is read, not assumed. If the class has no stock, say so and offer an alternative class or region — do not create into an unavailable class.
- Pick the image for the use: an interactive app (e.g. a ComfyUI or PyTorch image) for dev, a CUDA/PyTorch base for training. Match the image's CUDA to what the GPU class supports.
- **The image comes from this session's reads, not memory.** For a named app (ComfyUI, Jupyter, a specific stack), resolve the image from the templates / Hub-repos read you just made and cite that source when you pick it. An image already running on the account — visible in a `list-pods` read — is also a session-read source worth checking when the catalog comes up empty; cite the pod you saw it on. Only when the catalog has no match may you fall back to a well-known public image — and then say so explicitly in the answer. A from-memory image tag is how you get a stale image that crash-loops on boot.
- Decide the ports from the workload: the app's own port over HTTP for a web UI, `8888/http` for Jupyter, `22/tcp` for SSH. Only expose what the user needs to reach.
- **State the cost.** Quote the GPU's hourly rate from the catalog read before creating. A running Pod bills whether or not the user is using it.

## Phase 2 — create and connect

- **Interactive / dev Pod.** Create the Pod with the chosen image, GPU class, disk, ports, and data center. After it reaches running, inspect it and read back the exposed ports and the proxy address — `publicIp`/`portMappings` are empty while the container initializes, so poll until it is fully running before handing back a URL. App images are large and can take minutes to pull — a slow boot is NOT a failure: never create a second Pod because the first is still pulling. State the proxy URL form (`https://<podId>-<port>.proxy.runpod.net`) as soon as the Pod id exists; if the app has not bound after the waits your tools can hold, deliver the evidenced status report (pod id, state, last log line) and the recommended next step — offering to keep watching is fine. The reachable form for an HTTP port is the proxy URL `https://<podId>-<port>.proxy.runpod.net`; for SSH, hand back the host/port from the Pod's TCP mapping. Confirm the app actually bound (read the boot log for the "listening on 0.0.0.0:PORT" line) before telling the user it is reachable.
- **Create then pause for later.** When the user wants the Pod created but paused right away ("stops billing", "I'll continue tomorrow"), create it, confirm it reached running, then STOP it — never terminate: terminate destroys the container disk the user asked to keep. After the stop, the answer must state the consequences precisely: the container disk persists and keeps billing a small storage amount (the GPU compute rate stops); the physical GPU is released while stopped and may be claimed by another renter, so resuming may need to re-acquire a GPU and can land on a different host; anything on a network volume is unaffected. Tell the user exactly how to resume (start the Pod; if the original GPU class is taken, start will re-acquire from stock).
- **Training Pod with durable checkpoints.** Checkpoints written to container disk die with the Pod, so co-locate a network volume: create the volume in the same data center you will place the Pod (see `lifecycle-crud`), then create the Pod with that volume mounted at a checkpoint path (e.g. `/workspace` or `/checkpoints`) and pin the Pod to that data center. Tell the user the mount path and that checkpoints there survive the Pod being stopped or terminated, while container disk does not. Size the volume to the expected checkpoint total with headroom. The same network volume mounts at `/workspace` on a Pod but at `/runpod-volume` on a Serverless worker — if these checkpoints will later be read by a serverless endpoint, its handler must read them at `/runpod-volume`, not the pod path.

## Phase 3 — hand back

- The hand-back lives in your FINAL message and stands alone (router contract): the Pod id, the exact image it runs and which template/Hub read it came from, the GPU class WITH the stock evidence that justified it (quote the availability read: "RTX 3090 — N available in EU-RO-1"), the reachable URL(s) verbatim (the full proxy URL for HTTP, host:port for SSH — never "the link above", and never the boot log's internal `0.0.0.0:<port>` address, which is not a reachable URL), the mount path if a volume was attached, and the Pod's state with the hourly cost that is now running — for a stopped Pod, always with the billing consequence in the same breath: GPU billing ended, storage (container disk / any volume) still bills until termination.
- **Cleanup.** The default is to keep the Pod the user asked for and tell them what is billing and how to stop it (stop keeps the disk and bills storage only; terminate destroys container disk — a network volume survives either). Tear down — and delete any volume created only for the exercise — only when the user framed the journey as a throwaway test or asks for cleanup, confirming by a read-back.

## Hard rules

- Confirm stock before creating. Never create into a GPU class with no availability.
- State the hourly cost before creating any Pod, and before creating a network volume.
- Create only the Pod the user asked for. Never stop, terminate, or modify a Pod (or volume) the user did not name.
- Do not hand back a proxy URL until the Pod is fully running and the app has bound to the port — an empty `portMappings` means it is still initializing, not broken.
- For training, checkpoints must land on a network volume, not container disk — otherwise a stop/terminate loses them.
- Expose only the ports the workload needs. Do not open SSH or extra ports the user did not ask for.
- Never claim a Pod is reachable on the create call alone; read back its state first.

## Error handling

- Create returns `no gpu available` / a stock error → the class ran out between the read and the create; surface it and offer another class or region rather than retrying the same one.
- The Pod reaches running but `publicIp`/`portMappings` are still empty → it is still initializing; poll `get-pod` until they populate before handing back a URL. This is RunPod API behavior, not a failure.
- The proxy URL 502s right after create → the app inside has not bound to the port yet, or bound to `127.0.0.1` instead of `0.0.0.0`; read the boot log to confirm before declaring the Pod broken (deeper diagnosis is `pod-doctor`).
- `create-network-volume` returns a quota error → the account is at its volume quota; tell the user and stop.
- A create call fails → report it and stop; do not retry blindly or create a second Pod.
- The Pod is running but the app is still pulling/booting after minutes → that is normal for multi-GB images, not grounds for a replacement Pod or an open-ended wait; follow the bounded-wait hand-back above.

## Per-server tool binding

| Capability | This server | Official `runpod-mcp` |
|---|---|---|
| GPU stock per data center | `list-gpu-types` (`include:["AVAILABILITY"]`), `get-gpu-type` | `list-gpu-types` |
| Capacity matrix (per host CUDA version) | `get-capacity` | *(unbound — GraphQL-only)* |
| Data centers | `list-data-centers`, `get-data-center` | `list-data-centers` |
| Create a network volume | `create-network-volume` | `create-network-volume` |
| Create a Pod | `create-pod` | `create-pod` |
| Inspect a Pod | `get-pod` | `get-pod` |
| List Pods | `list-pods` | `list-pods` |
| Read Pod boot logs | `stream-pod-logs` | *(unbound — no REST log stream)* |
| Stop a Pod (keep disk) | `pod-action` (`{"action":"stop"}`) | `stop-pod` |
| Resume a stopped Pod | `pod-action` (`{"action":"start"}`) | `start-pod` |
| Terminate a Pod | `delete-pod` | `delete-pod` |

Where a capability is unbound on a server, say "not available on this server" and work with what the server does offer.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey.
