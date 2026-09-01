---
name: api-boundary
description: Recognize when a task exceeds RunPod's current management-API surface and answer honestly — state the gap plainly, name the specific operation that isn't exposed, and give the real working path. Never fabricate a tool call or claim a silent success. Trigger on phrases like "store a secret / gated Llama token", "set up secrets", "move my dataset in / checkpoints out", "transfer files to my pod", "multi-node training cluster", "instant cluster".
---

# API boundary

Some operations a user asks for are simply not on the RunPod management API today. Your job is to say so plainly — name the exact gap, do not fabricate a tool that would do it, do not report a silent success — and then hand the user the real working path. Any account fact you cite (a Pod, a volume) is read from the API, never invented.

The honest answer *is* the deliverable here. A hallucinated `create-secret` or `create-cluster` call is the failure this skill exists to prevent.

## The discipline

- **Confirm the gap before asserting it.** The absence is real: there is no secrets tool and no cluster-create tool on the server (only cluster *billing* is readable). State the gap as a fact about the API surface, then pivot to the workaround.
- **Name the specific operation**, not a vague "can't do that" — "there's no REST/MCP tool to create a RunPod secret", "there's no endpoint to create an Instant Cluster", "the MCP/REST surface has no file-transfer tool — but the runpodctl CLI and the volume S3 API move files fine".
- **Give the real path** that works today, concrete enough to act on.
- **Ground any account fact in a read.** If you reference the user's volume or Pod as part of the workaround, list/inspect it first — don't assert one exists.
- **Never invent a capability.** No made-up tool name, no pretend success, no "I've stored your secret."

## The boundary cases

- **Secrets for a gated model — expected fail.** There is no secrets tool on the management API; RunPod Secrets are managed through the console / internal GraphQL, not REST. Say that plainly. The working path: create the secret in the RunPod console and reference it from the template/endpoint env (e.g. `{{ RUNPOD_SECRET_hf_token }}`), or — less safe but functional — pass the token directly as a plain env var on the template/endpoint you create. Recommend the console-secret route; name the plain-env-var route as the trade-off, not the default. Do not claim to have created a secret — no tool does.
- **Datasets in / checkpoints out — covered by other tooling, not a gap.** The MCP/management-API tool set has no file-transfer tool — no MCP call moves bytes to or from a Pod or volume — but this is *not* a product gap: the runpodctl CLI and the companion S3 tooling cover it directly. Point the user there rather than calling it impossible: `runpodctl send` / `runpodctl receive` for ad-hoc file moves, the S3-compatible API on network volumes (`aws s3` against the volume's S3 endpoint) for bulk dataset/checkpoint sync, the console cloud-sync integration, or `scp`/`rsync` over the Pod's SSH. In an MCP-only session, say the transfer runs through the runpodctl CLI or the volume S3 API — a real working path, just not an MCP tool. If checkpoints must survive the Pod, stage them on a network volume (confirm it exists with a read first) so the data outlives the compute.
- **Multi-node training cluster — expected fail.** There is no REST/MCP tool to create an Instant Cluster — the server exposes only cluster *billing* reads, not cluster creation or lifecycle. Say so. The working path: create the Instant Cluster from the RunPod console (Instant Clusters), then use the API for what it *can* do — read its billing, and manage the individual Pods once they exist. Do not fabricate a create call.

## Hard rules

- Never fabricate a tool call for an operation the API does not expose. If it isn't in the tool list, it does not exist — say so.
- Never report a silent success ("done / stored / created") for a gap operation. There is nothing to succeed at.
- State the gap as a specific missing operation, then the concrete workaround — both, in that order.
- Read any account fact you cite; don't assert a resource exists without listing/inspecting it.
- When RunPod later ships REST secrets or cluster-create, this re-classes to a normal deploy/lifecycle journey and the per-server tool binding gains the new tool — until then the honest gap answer is the right answer.

## Per-server tool binding

| Capability | This server | Official `runpod-mcp` |
|---|---|---|
| Create/store a secret | *(unbound — no secrets tool; console / internal GraphQL only)* | *(unbound)* |
| Create an Instant Cluster | *(unbound — no cluster-create tool; console only)* | *(unbound)* |
| Read Instant Cluster billing | `list-cluster-billing` | *(unbound)* |
| Transfer files to/from a Pod/volume | *(no MCP tool — covered by the runpodctl CLI: `send`/`receive`, volume S3 API, cloud-sync, SSH)* | *(no MCP tool — runpodctl CLI)* |
| Ground account facts (reads) | `list-pods`, `get-pod`, `list-network-volumes`, `get-network-volume`, `list-endpoints` | same names |

The secret and cluster-create rows are genuine gaps on both servers — name the gap and the workaround. File transfer is **not** a gap: no MCP tool moves bytes, but the runpodctl CLI covers it fully — hand off there rather than calling it impossible.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey.
