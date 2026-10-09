---
name: api-boundary
description: >-
  Recognize when a task exceeds what the Runpod MCP tools can do and answer honestly: name the specific
  operation that is not exposed and the real working path for it. Never fabricate a tool call or claim a silent
  success, and never refuse an operation the server serves; check the served tool list before calling
  anything a gap. Use when the user asks for file transfer to or from a Pod or volume, a command run inside a
  Pod, or anything else that looks like it should be a tool and is not.
metadata:
  concepts: [file-transfer, pod-ssh-access, pod-command-exec, runpodctl, network-volume, runpod-secret, instant-cluster]
---

# API boundary

Some operations a user asks for are not on the Runpod management API today. Your job is to say so, name the exact gap, and then hand the user the real working path. Do not fabricate a tool that would do it, and do not report a silent success. Any account fact you cite (a Pod, a volume) is read from the API, never invented.

The honest answer *is* the deliverable here. Do not invent a file-transfer call, and do not refuse an operation this server serves.

## The discipline

- **Confirm the gap against the served tool list before asserting it.** A gap is a fact about the tools this session was granted, not a memory: if a tool for the operation is in the list, there is no gap; run the journey instead. The management API grows, and what this skill answered as a gap last month may be a tool today.
- **Name the specific operation**, not a vague "can't do that": "the MCP/REST surface has no file-transfer tool, but the runpodctl CLI and the volume S3 API move files fine".
- **Give the real path** that works today, concrete enough to act on.
- **Ground any account fact in a read.** If you reference the user's volume or Pod as part of the workaround, list/inspect it first; don't assert one exists.
- **Never invent a capability.** No made-up tool name, no pretend success, no "I've moved your files."

## The boundary case

- **File transfer — covered by other tooling, not a gap.** The MCP/management-API tool set has no file-transfer tool (no MCP call moves bytes to or from a Pod or volume), but this is *not* a product gap: the runpodctl CLI and the companion S3 tooling cover it directly. Point the user there rather than calling it impossible: `runpodctl send` / `runpodctl receive` for ad-hoc file moves, the S3-compatible API on network volumes (`aws s3` against the volume's S3 endpoint, in the data centers that offer it) for bulk dataset/checkpoint sync, the console cloud-sync integration, or `scp`/`rsync` over the Pod's direct SSH (`ssh.direct`). In an MCP-only session, say the transfer runs through the runpodctl CLI or the volume S3 API: a real working path, though not an MCP tool. If checkpoints must survive the Pod, stage them on a network volume (confirm it exists with a read first) so the data outlives the compute.
- **Running a command inside a Pod — not an MCP tool either.** The management API has no command-exec route, so the path is SSH to the Pod (created with `startSsh: true` and a key registered on the account; connect with the Pod's `ssh` block) or the console's web terminal. Say so and hand over the command; never claim to have run it.

## Served now — route, don't refuse

Two operations that were console-only for a long time are served tools on this server. They are normal lifecycle journeys: hand them to **lifecycle-crud** and run them:

- **Account secrets** — `create-secret`, `list-secrets`, `get-secret`, `update-secret`, `delete-secret`. A secret's value is write-only: no read returns it, and it is consumed by setting an env var on a pod, endpoint, or template to `{{ RUNPOD_SECRET_<name> }}`, which Runpod substitutes at boot. The console route still exists; it is no longer the only one.
- **Instant Clusters** — `create-cluster`, `list-clusters`, `get-cluster`, `update-cluster` (rename only), `delete-cluster`, `list-cluster-pods`, with `list-cluster-billing` for the spend read.

## Hard rules

- Never fabricate a tool call for an operation the API does not expose. If it isn't in the tool list, it does not exist; say so.
- Never report a silent success ("done / stored / created") for a gap operation. There is nothing to succeed at.
- State the gap as a specific missing operation, then the concrete workaround. Give both, in that order.
- Read any account fact you cite; don't assert a resource exists without listing/inspecting it.
- Check the tool list before calling something a gap, and stop calling it one the moment the tool appears. Secrets and cluster lifecycle made that move and belong to the lifecycle journey now.

## Tool binding

| Capability | Tool |
|---|---|
| Create/store a secret | `create-secret`, `list-secrets`, `get-secret`, `update-secret`, `delete-secret` |
| Create an Instant Cluster | `create-cluster`, `list-clusters`, `get-cluster`, `update-cluster`, `delete-cluster`, `list-cluster-pods` |
| Read Instant Cluster billing | `list-cluster-billing` |
| Transfer files to/from a Pod/volume | *(no MCP tool — the runpodctl CLI: `send`/`receive`, the volume S3 API, cloud-sync, SSH)* |
| Run a command inside a Pod | *(no MCP tool — SSH or the console web terminal)* |
| Ground account facts (reads) | `list-pods`, `get-pod`, `list-network-volumes`, `get-network-volume`, `list-endpoints` |

File transfer and in-Pod command execution are the gaps: no MCP tool moves bytes or runs a command, but runpodctl, the volume S3 API and SSH cover them. Hand off there rather than calling it impossible. Confirm against the session's tool list before calling anything a gap.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey. If the `runpod` router skill has not been loaded in this conversation, load it now, before the next tool call: its rules on which resources you may change, when a request is the go, and when to stop for the user are not repeated here.
