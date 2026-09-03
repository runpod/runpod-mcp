---
name: lifecycle-crud
description: Create, verify (read-back), and manage the lifecycle of Runpod's reusable plumbing resources — templates, network volumes, and container registry credentials — plus caching model weights on a volume and diagnosing a private-registry pull failure. Trigger on phrases like "create a template", "reusable template", "make a network volume", "persistent storage", "cache weights on a volume", "add registry credentials", "private image won't pull", "clean up my template/volume".
---

# Lifecycle CRUD

You own the lifecycle of Runpod's reusable resources: templates, network volumes, and container registry credentials. The goal is a correctly provisioned resource the user can rely on: provision cleanly, confirm by reading the resource back, and leave it standing — tear down only when the user asked for a create-then-clean-up demo or explicit cleanup. Read the existing resources first so you never collide with or clobber something the user already has.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the per-server tool binding below.

- List / inspect / create / update / delete templates.
- List / inspect / create / update / delete network volumes.
- List / inspect / create / delete container registry credentials.
- Read data centers and their per-GPU availability — to place a volume in a GPU-co-located DC.

## Shared discipline (every resource)

- **Read first.** List existing resources before creating; confirm the name you intend to use is not already taken.
- **Touch nothing outside the resources this conversation created.** Never delete or update a resource this conversation did not create — a name that *looks* like test junk is not attribution (the router's mutations-bind rule); only your own create calls this session establish ownership.
- **Confirm by read-back.** After a create or update, inspect the resource and verify the fields you set came back as you set them — a write call's own response is not a read, so confirm from a fresh one rather than trusting the write. (An update is a PATCH: only the fields you send change, and omitted fields are left untouched — so send only what the user authorized.)
- **When the user asked for cleanup or a create-then-clean-up demo, tear down what the journey created** in dependency order (a volume in use by a Pod won't delete; a registry cred referenced by a Pod won't delete), confirming each deletion with a final read-back showing it is gone. Otherwise leave resources standing and say what exists and what it bills.
- **State cost before creating a billable resource.** A network volume bills storage per GB-month for as long as it exists — say the size and that it bills until deleted before you create it.

## Journeys

- **Reusable template CRUD.** List templates, create the template with the name and image/disk/ports/env the user specified, read it back to confirm; when they asked for a create-then-clean-up round-trip, delete it and confirm removal. A template referenced by a Pod or bound to an endpoint will refuse deletion — surface that, do not force it.
- **Network volume lifecycle.** List volumes, create the volume with the requested size in a data center the user (or the workload) needs. State the storage cost. Read it back and leave it to serve its purpose — it bills until deleted, so say so; delete and confirm only on an explicit cleanup ask. Note: a volume's size may only increase — a shrink is rejected.
- **Volume-backed weights architecture.** Cache large model weights on a network volume co-located with the GPU that will consume them: read the data centers with their per-GPU availability to pick a DC that has the target GPU in stock, create the volume there, and explain the wiring — mount path into the Pod/worker, weights downloaded once and reused, and the cold-start effect (first job pays the download, later jobs mount the cached weights). Place, don't guess: the volume must live in the same DC as the compute or the mount won't attach. The one network volume mounts at a different path per surface — `/workspace` on a Pod, `/runpod-volume` on a Serverless worker — so weights staged from a Pod are read by the endpoint handler at `/runpod-volume`, not the pod path.
- **Cleanup asks.** When asked to clean up resources and this conversation created nothing (or its creations are already gone), the honest answer is reads only: list the account, say plainly that nothing this conversation created remains, and hand back any stale-looking candidates (ids, names, why they look stale) for the user to decide. Never delete on a name-guess — that report is the complete answer.
- **Private registry creds + pull-fail diagnosis.** Create the registry credential for the private image. Credentials are write-only — the read-back will never return the username/password, and you must never echo the values you sent into the transcript or logs. When an image pull fails, diagnose the two distinct causes: a genuine **auth failure** (wrong/expired credential, or none attached — the fix is a valid registry cred) versus **Docker Hub anonymous rate-limiting** (an unauthenticated pull of a public image hitting the pull-rate cap — the fix is authenticating even for the public pull). Name which one from the error text; do not conflate them.
- **Missing credential values.** A registry credential is only useful with the user's real values: when none were supplied, ask for them — the user is the only source. Never invent placeholder values for a credential meant to be used, and never echo the values back once given.

## Hard rules

- Never touch a resource outside this journey's own creations.
- Never echo a registry credential value (username/password/token) into chat, a log, or a committed file. It is write-only by design — keep it that way.
- Verify every create/update by reading the resource back; verify every delete by a read-back showing absence.
- State the storage cost before creating a network volume.
- A delete rejected because the resource is in use is a correct API response — report it and stop, do not force-detach or delete the dependent resource the user did not name.

## Error handling

- A delete returns `204` with no body — that is success; confirm with a follow-up read.
- A volume/registry delete rejected with an in-use error means a Pod or endpoint still references it — name the blocker, do not cascade.
- A registry read that omits `username`/`password` is expected (write-only), not a bug.

## Per-server tool binding

| Capability | This server | Official `runpod-mcp` |
|---|---|---|
| Templates (list/get/create/update/delete) | `list-templates`, `get-template`, `create-template`, `update-template`, `delete-template` | same names |
| Network volumes (list/get/create/update/delete) | `list-network-volumes`, `get-network-volume`, `create-network-volume`, `update-network-volume`, `delete-network-volume` | same names |
| Registry creds (list/get/create/delete) | `list-registries`, `get-registry`, `create-registry`, `delete-registry` | same names |
| Data centers + per-DC GPU availability (for placement) | `list-data-centers` / `get-data-center` (`include:["GPU_AVAILABILITY"]`), `list-gpu-types` (`include:["AVAILABILITY"]`) | `list-data-centers`, `get-gpu-type` |
| Capacity matrix (per host CUDA version) | `get-capacity` | *(unbound — GraphQL-only)* |

`get-capacity` is a curated tool over GraphQL — the per-host-CUDA-version stock matrix has no REST home — so a server without it can still place a volume: the data-center reads carry per-GPU availability. If it is missing, say the CUDA-version matrix is "not available on this server" and place from that availability read.

## Report template — resource inventory

When asked what exists on the account (inventory, audit, "what's running"):
list pods, endpoints, templates, and network volumes; a table per non-empty
kind works well (name, id, status, GPU/size, $/hr where the read provides it),
with empty kinds noted in a line ("templates: none"). Close with the totals
(counts per kind, summed $/hr of running pods) and, if the user implied a
concern (cost, stuck resources), the verdict in one sentence.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey.
