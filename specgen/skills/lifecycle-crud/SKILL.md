---
name: lifecycle-crud
description: >-
  Create, verify by read-back, and manage the lifecycle of Runpod's reusable plumbing (templates, network
  volumes, container registry credentials, account secrets, the account's SSH public keys, and Instant Clusters),
  plus staging large model files on a volume and diagnosing a private-image pull failure. Use when the user
  wants one of those resources created, changed, inspected or removed through the Runpod MCP tools, or asks
  where a volume should live so a GPU can mount it. Also use for an account cleanup request: only what this
  conversation created may be removed; everything else is reported for the user to decide.
metadata:
  concepts: [template, network-volume, registry-credential, runpod-secret, ssh-key, instant-cluster, data-center, gpu-availability]
---

# Lifecycle CRUD

You own the lifecycle of Runpod's reusable resources: templates, network volumes, container registry credentials, account secrets, registered SSH public keys, and multi-node clusters. The goal is a correctly provisioned resource the user can rely on: provision cleanly, confirm by reading the resource back, and leave it standing. Tear down only when the user asked for a create-then-clean-up demo or explicit cleanup. Read the existing resources first so you never collide with or clobber something the user already has.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the tool binding below.

- List / inspect / create / update / delete templates.
- List / inspect / create / update / delete network volumes.
- List / inspect / create / delete container registry credentials.
- List / inspect / create / update / delete account secrets.
- Read and replace the account's registered SSH public keys.
- List / inspect / create / rename / delete multi-node clusters, and list a cluster's member pods.
- Read data centers and their per-GPU availability, to place a volume in a GPU-co-located DC.

## Shared discipline (every resource)

- **Read first.** List existing resources before creating; confirm the name you intend to use is not already taken.
- **Touch nothing outside the resources this conversation created or the user named.** Never delete or update a resource this conversation did not create unless the user named it by id or an unambiguous name and asked for exactly that change. A user-named resource is deleted only on the user's ask for that delete. A name that merely looks disposable, or one you found by listing, is not attribution (the router's mutations-bind rule).
- **Confirm by read-back.** After a create or update, inspect the resource and verify the fields you set came back as you set them. A write call's own response is not a read, so confirm from a fresh one. (An update is a PATCH: only the fields you send change, and omitted fields are left untouched, so send only what the user authorized.)
- **When the user asked for cleanup, or framed the create as a round trip to be removed afterwards, tear down what the journey created** in dependency order (a registry credential won't delete while a Pod is pulling with it, but a template that references it is not checked and silently loses it), confirming each deletion with a final read-back showing it is gone. Otherwise leave resources standing and say what exists and what it bills.
- **State cost before creating a billable resource.** A network volume bills storage per GB-month for as long as it exists. Say the size, and that it bills until deleted, before you create it. A cluster is GPU compute: it rents `podCount` × `gpuCountPerPod` GPUs from creation, so state that total hourly price (per-GPU price × the GPU count, from the catalog reads) before creating one.

## Journeys

- **Reusable template CRUD.** List templates, create the template with the name and image/disk/ports/env the user specified, read it back to confirm; when they asked for a create-then-clean-up round-trip, delete it and confirm removal. A template referenced by a Pod or bound to an endpoint will refuse deletion; surface that, do not force it.
- **Network volume lifecycle.** List volumes, create the volume with the requested size (10 to 4096 GB) in a data center the user (or the workload) needs and that offers network storage (a non-empty `networkVolumeTypes` on the data-center read). State the storage cost. Read it back and leave it to serve its purpose. It bills until deleted, so say so; delete and confirm only on an explicit cleanup ask. A volume's size may only increase; a shrink is rejected.
- **Volume-backed model files.** Keep large model files on a network volume co-located with the GPU that will consume them. Read the data centers with their per-GPU availability (`include:["GPU_AVAILABILITY"]`) to pick a data center that has the target GPU in stock for the product you will run there, and create the volume there. Explain the wiring: mount path into the Pod/worker, weights downloaded once and reused, and the cold-start effect (first job pays the download, later jobs mount the cached weights). Place, don't guess: the volume must live in the same data center as the compute or the mount won't attach, and network volumes attach to Secure Cloud compute only. On a Pod the mount path is the one you set in `mounts` (no default); a Serverless worker always sees the volume at `/runpod-volume`, so weights staged from a Pod are read by the endpoint handler at `/runpod-volume`, not the pod path.
- **Cleanup asks.** When asked to clean up resources and this conversation created nothing (or its creations are already gone), the honest answer is reads only: list the account, say that nothing this conversation created remains, and list the resources that look unused (ids, names, the evidence from the reads) for the user to decide. Never delete on a name-guess; that report is the complete answer.
- **Private registry creds + pull-fail diagnosis.** Create the registry credential for the private image. Credentials are write-only: the read-back will never return the username/password, and you must never echo the values you sent into the transcript or logs. When an image pull fails, diagnose the two distinct causes: an **auth failure** (wrong/expired credential, or none attached; the fix is a valid registry cred) versus **Docker Hub anonymous rate-limiting** (an unauthenticated pull of a public image hitting the pull-rate cap; the fix is authenticating even for the public pull). Name which one from the error text; do not conflate them.
- **Missing credential values.** A registry credential is only useful with the user's real values: when none were supplied, ask for them, since the user is the only source. Never invent placeholder values for a credential meant to be used, and never echo the values back once given.
- **Account secret CRUD.** List the secrets first: the `name` is unique across the account and immutable, so a colliding create is rejected with `409`. Create it with the user's real value (they are the only source; never invent one), read it back to confirm the metadata, and tell the user how it is consumed: set an env var on the template, pod, or endpoint to `{{ RUNPOD_SECRET_<name> }}` and Runpod substitutes the stored value when the pod or worker boots. The value itself is write-only: no read returns it, and you never echo it into the transcript. When the user has not given the value yet, give the whole plan first (the secret name you will use, that the endpoint or template reads it as `{{ RUNPOD_SECRET_<name> }}`, and that the value is never shown back), then ask for the value. Rotating is `update-secret`; the new value reaches pods and workers at their next boot, so say that a running instance keeps the value it started with. Deleting a secret is not blocked while it is in use: the references stop resolving and the next pod or worker start that needs them fails, so point the user at the references before a delete.
- **SSH keys on the account.** `update-ssh-keys` is a replace-all PUT, not an append: read the current keys first, send them back together with the new one, and confirm with a read. Sending only the new key silently removes every other key on the account, and `[]` removes all of them. Keys apply to pods created afterwards with `startSsh`; a running pod is not updated.
- **Multi-node cluster lifecycle.** A cluster is billable compute, not plumbing: every GPU in it bills from the moment it exists, at the catalog price per GPU times the GPU count. Read the account's clusters, the GPU's stock (`include:["AVAILABILITY"]` with `product:["CLUSTER"]`, because cluster stock differs from pod stock) and the price first. Then put the exact shape (nodes, GPUs per node, data center) and the total hourly price (`podCount` × `gpuCountPerPod` GPUs of the chosen type, priced from the catalog) in front of the user and ask for the go. Only an explicit go in this conversation unlocks `create-cluster`; a request to create or provision a cluster is the request for that plan, not the go. When the read shows no stock for that GPU, say so and propose the closest shape the read shows in stock. The cluster type, GPU type and GPUs per pod are fixed at creation and `update-cluster` only renames; pods are added or removed from the console (Scale cluster), not through these tools. So get the shape right the first time and hand a resize to the console. Cluster pods can carry a higher rate than the pod GPU price, so after creation confirm the real rate with `list-cluster-billing`. `templateId` provisions every member pod from a pod template and is the only private-image path (a bare `registry` on the create body is rejected). Read the cluster back with `get-cluster` for the aggregate pod summary, and `list-cluster-pods` for the member pods themselves; `list-cluster-billing` is the spend read.

## Hard rules

- Never touch a resource outside this journey's own creations, except the one the user named for the change they asked for.
- Never echo a registry credential value (username/password/token) or a secret value into chat, a log, or a committed file. Both are write-only by design; keep them that way.
- Read the registered SSH keys before replacing them. `update-ssh-keys` overwrites the whole set; a send that omits an existing key deletes it.
- Verify every create/update by reading the resource back; verify every delete by a read-back showing absence.
- State the storage cost before creating a network volume and the total hourly price before creating a cluster. For a cluster, wait for the user's explicit go as well.
- A delete rejected because the resource is in use is a correct API response. Report it and stop; do not force-detach or delete the dependent resource the user did not name.

## Error handling

- A delete returns `204` with no body. That is success; confirm with a follow-up read.
- A volume or registry-credential delete rejected with an in-use error means a Pod is still using it. Name the blocker; do not cascade. A template's reference does not block a credential delete; the template is cleared instead, so check templates before deleting a credential they use.
- A registry read that omits `username`/`password` is expected (write-only), not a bug.
- A secret read that omits the value is expected (write-only), not a bug; a create rejected with `409` means the name is taken. Names are immutable, so pick another or rotate the existing secret with `update-secret`.
- `update-secret` carrying both a value and a description is not atomic: if the description write fails after the value rotated, the error response comes back with the new value already in effect. Send the two in separate calls when that partial outcome matters.
- A cluster update that tries to change compute, type, or container config is rejected, because that endpoint renames only. Report it, offer the console's Scale cluster for the pod count, and delete-and-recreate for anything else, with the price restated.

## Tool binding

| Capability | Tool |
|---|---|
| Templates (list/get/create/update/delete) | `list-templates`, `get-template`, `create-template`, `update-template`, `delete-template` |
| Network volumes (list/get/create/update/delete) | `list-network-volumes`, `get-network-volume`, `create-network-volume`, `update-network-volume`, `delete-network-volume` |
| Registry credentials (list/get/create/delete) | `list-registries`, `get-registry`, `create-registry`, `delete-registry` |
| Data centers with per-GPU availability (for placement) | `list-data-centers` / `get-data-center` (`include:["GPU_AVAILABILITY"]`); `list-gpu-types` (`include:["AVAILABILITY"]` with `product`) |
| CUDA versions with capacity, per GPU type | the GPU read's `cudaVersions`; `get-capacity` for the matrix view |
| Account secrets (list/get/create/update/delete) | `list-secrets`, `get-secret`, `create-secret`, `update-secret`, `delete-secret` |
| Registered SSH public keys (read/replace) | `get-ssh-keys`, `update-ssh-keys` |
| Clusters (list/get/create/rename/delete, member pods, billing) | `list-clusters`, `get-cluster`, `create-cluster`, `update-cluster`, `delete-cluster`, `list-cluster-pods`, `list-cluster-billing` |

If a tool named here is missing from the session's tool list, say so and use the nearest read instead of inventing a result.

## Report template — resource inventory

When asked what exists on the account (inventory, audit, "what's running"):
list pods, endpoints, templates, and network volumes; a table per non-empty
kind works well (name, id, status, GPU/size, $/hr where the read provides it),
with empty kinds noted in a line ("templates: none"). Close with the totals
(counts per kind, summed $/hr of running pods) and, if the user implied a
concern (cost, stuck resources), the verdict in one sentence.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey. If the `runpod` router skill has not been loaded in this conversation, load it now, before the next tool call: its rules on which resources you may change, when a request is the go, and when to stop for the user are not repeated here.
