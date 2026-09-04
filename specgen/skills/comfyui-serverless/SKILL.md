---
name: comfyui-serverless
description: Host a ComfyUI workflow as a serverless endpoint and prove it with one generated image. Owns the workflow-as-job-input pattern (the workflow JSON rides each job request, it is never baked into the image), worker-variant selection by the models the workflow references, and custom-model provisioning (Civitai checkpoints/LoRAs, extra upscalers) via an explicit mechanism with its cold-start consequence stated. Trigger on phrases like "make my workflow.json an api", "host this comfyui workflow", "productionize this workflow file", "comfyui endpoint with my civitai model", "serve my custom lora as an api", "comfyui serverless".
---

# ComfyUI serverless

You turn a ComfyUI workflow into a working serverless endpoint and prove it with one image. Two facts drive everything: the workflow JSON is **job input** — each request carries it in the job payload, so a custom workflow needs no custom image — and the worker image only serves what its bundled model set (plus anything you explicitly provision) can load. The journey is: read the workflow, list what it references, match a worker variant, provision what the variant lacks by an explicit mechanism, deploy, run the user's own workflow once, hand back the proof.

## Phase 1 — read the workflow and inventory its references

- Read the user's workflow file FIRST. Walk its nodes and list every external file it references: the checkpoint (`CheckpointLoaderSimple.ckpt_name`), LoRAs, VAEs, upscale models, controlnets. This inventory decides everything downstream — a deploy that guesses the requirements is wrong even when it boots.
- Note nodes that need no files (latent upscale, standard samplers) — they run anywhere and need no provisioning.

## Phase 2 — pick the worker and cover the model inventory

- Resolve the ComfyUI serverless worker from the Hub catalog (`list-hub-repos`, the runpod-workers ComfyUI worker family). Worker variants bundle different model sets — pick the variant whose bundled set covers the workflow's checkpoint (an SDXL workflow wants the SDXL-bundled variant). Cite the hub read you picked it from.
- For every referenced file the variant does NOT bundle, choose ONE provisioning mechanism and say so plainly:
  1. **Network volume staging** — create a volume in the endpoint's data center, attach it, and name the exact ComfyUI model paths the files must land under (checkpoints/, loras/, upscale_models/ beneath the mount). The management API cannot upload files: create and wire the volume yourself, then hand the user the ONE staging step (what to download, to which exact path) — that hand-back is part of the mechanism, not a failure.
  2. **Baked custom image** — the user builds an image with the models at the ComfyUI paths and hands back the reference; you deploy from it. Choose this only when the user prefers owning an image.
  3. **Worker-supported download env** — only if the worker's own config (from the hub read) documents one; never invent an env var the worker does not list. The ComfyUI worker does not document a Civitai download env — do not pretend it does.
- State the chosen mechanism's cold-start consequence: baked image = bigger pull, volume = one-time download then cached mounts, per-boot download = paid on every cold start.
- Civitai specifics: resolve the model page to the actual file and its size when a web-read tool is granted. When it is not, do NOT stall the deploy waiting for it — wire the volume and endpoint anyway, and fold the exact-file lookup into the user's staging step ("on the model page's Files tab, download the .safetensors file to <exact volume path>"). If the file needs Civitai auth, ask for the token or wire it as an env var with the plaintext caveat — never invent one, never echo one.

## Phase 3 — deploy, prove with the user's own workflow, hand back

- Create the endpoint scale-to-zero (min workers 0) unless warm capacity was asked for. State the GPU hourly price from the catalog read before creating.
- Smoke-test with the USER'S workflow as the job input — not a substitute prompt. One job, held server-side (runsync then status holds, per serverless-deploy's smoke-test discipline); if the wait outlasts the holds, report the evidenced state.
- Close with everything in one place: the endpoint id, the worker/variant and the hub read it came from, which models are bundled vs provisioned (and how) vs handed to the user to stage (a small table reads well), the job result (the image output reference, or the evidenced blocker), the hourly price, and — when staging was handed to the user — the exact single step they run.

## Hard rules

- Read the workflow before any deploy decision; every requirement you name must come from it.
- Never bake the workflow into an image or tell the user one is needed for a custom workflow — the workflow rides the job payload.
- Never claim a model loaded without job or log evidence; a run that silently fell back to a base model is a failure to report, not a success.
- Never invent worker env vars, download URLs, or Civitai tokens. Mechanisms you cannot execute through the granted tools are handed to the user as one concrete step, with what you DID wire (volume, endpoint, mounts) already in place.
- Scale-to-zero by default; a nonzero minimum bills around the clock and needs the user's ask.

## Per-server tool binding

| Capability | This server | Official `runpod-mcp` |
|---|---|---|
| Find the ComfyUI worker | `list-hub-repos` | `list-hub-repos` |
| Deploy from the hub | `deploy-hub-repo` | `deploy-hub-repo` |
| Template + endpoint (custom image path) | `create-template`, `create-endpoint` | same names |
| Volume for custom models | `create-network-volume` | `create-network-volume` |
| Smoke job with the workflow | `runsync-endpoint` / `run-endpoint` + `get-job-status` | same names |
| Read-back / teardown | `get-endpoint`, `delete-endpoint`, `delete-template`, `delete-network-volume` | same names |

Where a capability is unbound on a server, say "not available on this server" and work with what the server does offer.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey.
