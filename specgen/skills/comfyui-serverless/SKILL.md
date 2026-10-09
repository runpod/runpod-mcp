---
name: comfyui-serverless
description: >-
  Host a ComfyUI workflow as a serverless endpoint and prove it with one generated image. Owns the
  workflow-as-job-input pattern (the workflow JSON rides each job request, it is never baked into the image),
  worker-variant selection by the models the workflow references, and custom-model provisioning (Civitai
  checkpoints/LoRAs, extra upscalers) via an explicit mechanism with its cold-start consequence stated. Use when
  the user has a ComfyUI workflow, or custom image-generation models, and wants them served as an API on Runpod
  Serverless through the Runpod MCP tools.
metadata:
  concepts: [serverless-endpoint, serverless-handler, hub-repo, network-volume, worker, job, model-store]
---

# ComfyUI serverless

You turn a ComfyUI workflow into a working serverless endpoint and prove it with one image. Two facts drive everything. First, the workflow JSON is **job input**: each request carries it in the job payload, so a custom workflow needs no custom image. Second, the worker image only serves what its bundled model set (plus anything you explicitly provision) can load. The journey is: read the workflow, list what it references, match a worker variant, provision what the variant lacks by an explicit mechanism, deploy, run the user's own workflow once, hand back the proof.

## Phase 1 — read the workflow and inventory its references

- **No workflow in the request.** The workflow rides each job request, so the endpoint does not depend on it. Deploy the ComfyUI worker variant whose bundled model set matches the model class the user named (from the hub read), wire the custom-model mechanism below only for a model the user explicitly named, and hand back where the workflow JSON goes in the job payload. Without a workflow there is no smoke job. Say that the first job with their workflow is the proof, and ask for anything only the user can supply (the workflow, a model page, a token) in the same message that reports the deployed endpoint. When the request names neither a workflow nor the model's base class (SD 1.5, SDXL, Flux), deploy the ComfyUI worker's listed Hub release as it stands and state the model set it bundles, create and attach the network volume for the custom file, and in the same message that reports the endpoint ask for the model page (or its base class) and the workflow. Missing details about the user's model are no reason to deploy nothing.
- Read the user's workflow file FIRST when one was given. Walk its nodes and list every external file it references: the checkpoint (`CheckpointLoaderSimple.ckpt_name`), LoRAs, VAEs, upscale models, controlnets. This inventory decides everything downstream: a deploy that guesses the requirements is wrong even when it boots.
- Note nodes that need no files (latent upscale, standard samplers); they run anywhere and need no provisioning.

## Phase 2 — pick the worker and cover the model inventory

- Resolve the ComfyUI serverless worker from the Hub catalog (`list-hub-repos`, the runpod-workers ComfyUI worker family). Worker variants bundle different model sets. Pick the variant whose bundled set covers the workflow's checkpoint (an SDXL workflow wants the SDXL-bundled variant). Cite the hub read you picked it from.
- For every referenced file the variant does NOT bundle, choose ONE provisioning mechanism and say which:
  1. **Network volume staging** — create a volume in the endpoint's data center, attach it, and name the exact ComfyUI model paths the files must land under (checkpoints/, loras/, upscale_models/ beneath the mount). The management API cannot upload files: create and wire the volume yourself, then hand the user the ONE staging step (what to download, to which exact path). That hand-back is part of the mechanism, not a failure.
  2. **Baked custom image** — the user builds an image with the models at the ComfyUI paths and hands back the reference; you deploy from it. Choose this only when the user prefers owning an image.
  3. **Worker-supported download env** — only if the worker's own config (from the hub read) documents one; never invent an env var the worker does not list. The ComfyUI worker does not document a Civitai download env, so do not pretend it does.
  4. **Runpod's model repository (model caching)** — for a model hosted outside Hugging Face, `runpodctl model add` uploads the file to the repository and the endpoint's model reference (set in the console or with `runpodctl serverless create --model-reference`; the MCP tools do not set it) mounts it on every worker. Hand both steps to the user as staging steps, run from a shell with runpodctl or the console.
- State the chosen mechanism's cold-start consequence: baked image = bigger pull, volume = one-time download then cached mounts, per-boot download = paid on every cold start.
- Civitai specifics: resolve the model page to the actual file and its size when a web-read tool is granted. When it is not, do NOT stall the deploy waiting for it. Wire the volume and endpoint anyway, and fold the exact-file lookup into the user's staging step ("on the model page's Files tab, download the .safetensors file to <exact volume path>"). If the download needs Civitai auth, the token comes from the user: ask for it, and when you set it as an env var, say the value sits in plain text in the config. Never invent or echo a token.

## Phase 3 — deploy, prove with the user's own workflow, hand back

- Create the endpoint scale-to-zero (min workers 0) unless warm capacity was asked for. State the GPU hourly price from the catalog read before creating.
- Smoke-test with the USER'S workflow as the job input, not a substitute prompt. One job, submitted with `run-endpoint` and held server-side with `get-job-status` and `wait` (a cold first job outlives `runsync`'s hold and its one-minute result window), per serverless-deploy's smoke-test discipline. If the wait outlasts the holds, report the evidenced state. When no workflow was given, skip the job and say so (phase 1).
- Close with everything in one place: the endpoint id, the worker/variant and the hub read it came from, which models are bundled vs provisioned (and how) vs handed to the user to stage (a small table reads well), the job result (the image output reference, or the evidenced blocker), the hourly price, and, when staging was handed to the user, the exact single step they run.

## Hard rules

- Read the workflow before any deploy decision when one was given; every requirement you name must come from it. Without one, deploy only what the user named (the worker variant for their model class, their custom model) and nothing inferred.
- Never bake the workflow into an image or tell the user one is needed for a custom workflow; the workflow rides the job payload.
- Never claim a model loaded without job or log evidence; an output produced without the custom model loading is a failure to report, not a success.
- Never invent worker env vars, download URLs, or Civitai tokens. Mechanisms you cannot execute through the granted tools are handed to the user as one concrete step, with what you DID wire (volume, endpoint, mounts) already in place.
- Scale-to-zero by default; a nonzero minimum bills around the clock and needs the user's ask.

## Tool binding

| Capability | Tool |
|---|---|
| Find the ComfyUI worker | `list-hub-repos` |
| Deploy from the Hub | `deploy-hub-repo` |
| Template + endpoint (custom image path) | `create-template`, `create-endpoint` |
| Volume for custom models | `create-network-volume` |
| Smoke job with the workflow | `run-endpoint` + `get-job-status` (`wait`) |
| Read-back / teardown | `get-endpoint`, `delete-endpoint`, `delete-template`, `delete-network-volume` |

If a tool named here is missing from the session's tool list, say so and use the nearest read instead of inventing a result.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey. If the `runpod` router skill has not been loaded in this conversation, load it now, before the next tool call: its rules on which resources you may change, when a request is the go, and when to stop for the user are not repeated here.
