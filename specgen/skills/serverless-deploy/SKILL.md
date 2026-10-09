---
name: serverless-deploy
description: >-
  Bring any source (a HuggingFace repo, a ComfyUI workflow, a Hub release, a custom container image, a GGUF
  repo, a Civitai asset, or a community template) to a proven Runpod Serverless endpoint: pick the engine for
  the modality and model format, size the GPU from the model's real metadata, provision, warm, prove it with one
  real job, and hand back the URL with what it bills. Deploys an existing source through the Runpod MCP tools;
  code-first Python deploys (the Flash dev loop) are out of scope. Use when the user wants a model or worker
  served on Runpod Serverless, whatever the modality: text generation, speech-to-text or text-to-speech, image
  or video generation, embeddings, document processing, or their own handler image.
metadata:
  concepts: [serverless-endpoint, serverless-handler, worker, job, gpu-pool, gpu-availability, hub-repo, template, network-volume, endpoint-release, flashboot, registry-credential]
---

# Serverless deploy

You take *any* deployable source and turn it into a working, queue-backed Serverless endpoint that you have proven with one real job, and you leave the user knowing exactly what now exists and what it bills. The steps never change: read the source, decide the engine and the hardware, provision, warm, smoke-test one real job, hand back the URL and a `curl`, state what is billing. Tear down only when the user framed the deploy as a throwaway test or asks for cleanup.

Two decisions are yours to make without being told: the **engine family** (which worker image is correct for this modality and model format) and the **provisioning path** (bake weights into the image vs download-on-start vs stage on a network volume, each with a different cold-start cost). Size hardware from the model's real metadata, never a guess. When several suitable workers exist for the modality, prefer the smallest, most-proven image for a smoke-able deploy. A giant image turns the first job into a cold start of many minutes, and the smoke test's job is proof of the journey, not maximal quality. Name the trade-off if the user's request implies a heavier engine. Creating an endpoint is billable: state the hourly cost of the GPU class before you create it, and remember a smoke job costs money.

For code-first Python (writing endpoint functions in a project and iterating with Runpod's Python dev loop, runpod-flash), this MCP-only bundle has no path. Say so instead of improvising one. This skill deploys an existing source (Hub repo, container image, ComfyUI workflow, Hub release) to an endpoint through the MCP tools.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the tool binding below. This skill reads the catalog before it creates, and creates only what the user asked to deploy.

- Read GPU catalog + price + live stock, per-data-center availability, and the CUDA versions that have capacity: sizing and stock (delegate the sizing math to `discovery`).
- Browse the Hub worker catalog, with the release config, to find a prebuilt worker or a community template and read its hardware/env schema.
- Deploy a Hub release directly as an endpoint: the one-call Hub path.
- Create a template (image, disk, ports, env, registry, mounts): the reusable worker preset.
- Create a Serverless endpoint (GPU pools, worker min/max, scaler, data centers, network volumes).
- Create a network volume to stage large weights in a GPU-co-located data center.
- Pin GPUs / set GPU count per worker: `gpu.count` and the pool plus `excludedTypes` selection; `set-endpoint-gpus` builds the exclusion list and preserves the other settings.
- Read endpoint health and list workers: warmup and readiness, and the cold-start-vs-crash-loop evidence together with the worker logs (a crash-looping container can still report RUNNING or INITIALIZING).
- Submit a job and block on it: the smoke test (`run-endpoint`, then `get-job-status wait:300000` on the job id until terminal; `runsync-endpoint` only for a warm endpoint and a fast job, since its result is kept for one minute).
- Read a worker's logs *when that tool is available to you*: model-load / crash evidence. When it is not, `endpoint-health` + `list-endpoint-workers` give the worker-health counts, which narrow the cause but cannot settle a crash loop on their own.
- Delete the endpoint, template, and any network volume: teardown of everything created.

## Phase 0 — identify the source and pick the engine (unprompted decision)

Read the source the user gave you and classify it. The engine family follows from the modality and the model format, not from a default. Never serve a non-text-generation task on a vLLM or ComfyUI worker.

| Source / modality | Correct engine family | Worker image kind |
|---|---|---|
| Text-generation LLM, `safetensors` weights | vLLM or SGLang | `runpod/worker-v1-vllm` (or SGLang worker) |
| Text-generation LLM, `GGUF` quantized weights | llama.cpp / Ollama | a GGUF-capable worker — **not** vLLM |
| Image/diffusion `workflow.json` | ComfyUI | `runpod/worker-comfyui` |
| Speech-to-text (transcription) | a Whisper-family model | a speech-to-text worker, not an LLM worker |
| Text-to-speech / voice cloning | a TTS model | a TTS worker |
| Speaker diarization | a diarization pipeline | a diarization worker from the Hub or public catalog |
| OCR / document extraction | a classic OCR engine | an OCR worker, not a VLM chat worker |
| Text embeddings | an embeddings server (e.g. text-embeddings-inference) | an embeddings worker |
| A custom handler you were given | your own image | a custom container image |

- **Format detection.** Inspect the repo's files before choosing. `*.safetensors` / `*.bin` → vLLM/SGLang. `*.gguf` → a llama.cpp/Ollama worker. Deploying a GGUF repo on worker-vllm is a common wrong-engine mistake: vLLM will not load it. State the format you detected and the engine it implies in the final message; the detection is part of the answer, not only the decision.
- **OCR sizing.** For an OCR/document-extraction smoke deploy, default to a classic lightweight OCR worker (16–24 GB). A VLM-based OCR (7B+ params) is a big-model deploy: size it like one (48 GB class) or don't pick it for a smoke test.
- **Community-template source.** When the modality has no first-party Runpod worker, browse the Hub / public catalog for a **community (non-Runpod)** template that serves it. Name the repo and its owner from the listing, never assert a repo from memory. Once you have found a fitting worker, **deploy it and run one real job**. Do not stop at "I found X," and do not block on a credential the config makes optional (see the runtime-optional-token rule in phase 2); request the capability through the job input the worker's config documents. Only if the catalog returns nothing that fits do you say "none found" and stop; never invent a repo name or a Docker image.
- **Custom image.** When the user brings their own handler image, that image *is* the engine. Deploy exactly the image named, never a substitute. When its required env is missing, apply the model-default rule in phase 2 rather than asking; the observed worker states are the report, not a question back to the user. After the deploy, read the worker states (`list-endpoint-workers` or `endpoint-health`) and report what you observed. For a custom image the workers' observed health IS the deliverable: one completed job does not show a crash-looping sibling worker, so report a crash-looping custom image as failing. If it is in a private registry, the endpoint needs a registry credential (create/reference it; see `lifecycle-crud`); never echo the registry password. For a load-balancer (custom-HTTP, direct-routing) endpoint rather than the queue, the cardinal rule is that the worker must serve HTTP on `PORT` (default 80) AND answer the health check at `HEALTH_CHECK_PATH` (default `/ping`) on `PORT_HEALTH` (default 80). Miss either and workers never pass health, so the endpoint looks stuck with zero ready workers; the endpoint read returns the exact health URL being polled. The endpoint type is also immutable after create, and a load-balancer endpoint has no queue: when every worker is busy, requests fail instead of waiting, so size `workers.max` for the peak.

## Phase 1 — size the hardware (read the catalog, cite `discovery`)

Delegate the params×precision + KV/overhead VRAM math to `discovery`; this skill applies its result to a real GPU pick.

- Read the model's real metadata (parameter count, precision, and for diffusion the checkpoint/LoRA/VAE asset sizes). Do not size from the repo name alone when the config is readable.
- **Pinning to one card.** When the user wants the endpoint locked to an exact GPU, select the pool that contains the card and list the pool's other GPU types in `gpu.excludedTypes` (`gpu.pools` takes pool ids, not GPU type ids, and at least one type must remain), either on the create or with `set-endpoint-gpus` afterwards. The read-back quotes pools and exclusions to prove the pin, and every other setting is confirmed unchanged from the read.
- Pick the smallest GPU class whose VRAM fits, then confirm live stock from the GPU-availability read. `include:["AVAILABILITY"]` with `product:["SERVERLESS"]` (the two go together, and stock differs by product) also gives the per-data-center picture when the endpoint needs a specific data center, and the same read's `cudaVersions` shows which CUDA versions have capacity when a CUDA floor is in play. Pin that floor on the create: `gpu.minCudaVersion` at the image's CUDA line (12.8 for a CUDA 12 image; 13.0 only for an image built on CUDA 13), or `gpu.allowedCudaVersions` for an exact set; the two are mutually exclusive (400 if both are sent), and the floor must have stock in `cudaVersions`. Never create into a GPU class with no stock: a scale-to-zero endpoint that can never acquire a worker looks deployed but never runs.
- **Multi-GPU when one card can't hold the model.** When required VRAM exceeds the largest single card you can get with stock, set GPUs-per-worker > 1 and enable tensor parallelism in the worker env (e.g. the vLLM worker's tensor-parallel setting = GPU count). State that you are going multi-GPU and why (the model does not fit on one card), and that multi-GPU workers cost proportionally more per hour. Before committing, price the alternative in the answer: quote the largest in-stock single card (its VRAM, live stock, $/hr) against the multi-GPU pick.
- **Pin the pool on Hub deploys.** `deploy-hub-repo` inherits the release's GPU pool list when `gpuIds` is omitted, which can silently acquire a top-tier card for a task a 24 GB card serves, at several times the hourly rate. Pass `gpuIds` from YOUR sizing decision on every Hub deploy unless the release config pins exactly the pool your sizing chose.
- **CPU serverless.** `create-endpoint` takes one hardware choice: the `gpu` object (pools and count) or the `cpu` array of CPU flavor configurations, sized from the CPU catalog read (`list-cpu-types`). For a CPU workload send `cpu` and no `gpu` (never force a GPU pool onto a CPU workload), and quote the CPU flavor's hourly price before creating.
- **Set the defaults you mean.** A REST create defaults to FlashBoot `OFF`, `workers.max` 3, `workers.idleTimeout` 10 s and `timeout` 300 s; set `flashboot` and the worker bounds explicitly instead of inheriting them. The sum of `workers.max` across the account's endpoints is capped by a balance-tiered quota (5 to start), checked at create, so a second endpoint at the default of 3 can be refused.
- **State the cost.** Before creating, quote the chosen GPU's hourly rate (×GPU count) from the catalog read. Creating the endpoint and running the smoke test both bill.

## Phase 2 — provision

Two provisioning paths; choose by source.

- **Hub release.** If the source is a Hub repo, deploy its listed release directly (one call). Read the release config first (hardware requirements + env schema) so you pass only env keys the release accepts, and so you know its GPU/disk defaults. To reproduce a known-good build, pin the exact release rather than "latest".
- **Everything else.** Create a template that names the engine image, the disk size, the ports the worker exposes, and the env (model id, engine settings, tokens); then create the endpoint referencing it. Start scale-to-zero (min workers 0) unless the user asked for warm capacity; a nonzero minimum is an always-on billed worker. An image hosted on `registry.runpod.net` is a Hub build: deploy it through `deploy-hub-repo` (the release carries the registry auth); a plain template with that image loops on a registry-auth failure.
- **Provisioning path and cold start.** Bake-into-image = fastest cold start, biggest image; download-on-start = small image, slow first request per new worker; **network volume** = weights staged once in a GPU-co-located data center and mounted by every worker (writable, so coordinate concurrent writes), so new workers skip the download. Choose a network volume when weights are large (roughly > 30 GB) or shared across workers. Size it to the real asset total with headroom, create it in the same data center you place the endpoint in (see `lifecycle-crud`), and say which path you took and its cold-start consequence.
- **Multi-region / HA (no auto-sync).** For a multi-region endpoint you attach one network volume per data center. These per-DC volumes do **not** auto-sync: you replicate data across them yourself (e.g. an `aws s3` sync between the volumes' S3 endpoints), or each region serves stale or missing weights.
- **Required env, gated weights, and runtime-optional tokens.** Read the release/worker config (`includeConfig: true`) and SET every required env key that has no default before you deploy (e.g. an embeddings worker's model-id env such as `MODEL_NAMES`). Deployed without its model env, a worker loads nothing and 400s every job. When the user named no model for a text-generation worker (a vLLM image with no `MODEL_NAME`), pick the worker's documented default model when its config has one, otherwise the smallest instruct model that fits the card (a 1–2B instruct model on a 16 GB class), state the choice, and deploy. Do not ask which model. For a gated HuggingFace repo whose *weights* 403 without a token at download time, pass the token in env, and if the user gave none, say the download will 403 and ask. Do not deploy a build that cannot fetch its weights. A token needed only for an **optional runtime capability**, one whose config default is empty (a worker whose optional feature needs a token), branches on one check you make FIRST: did the user provide a token (pasted in the request, set in the environment, or named as available)?
  - **Token provided → using it is the job.** Set it as the worker env var at create (the token env the worker documents), say that you configured it (by env-var name, never the value), and expect the gated capability to work. Never deploy without wiring a credential the user handed you.
  - **No token → deploy anyway.** The deploy is NOT conditional on the token: don't park the whole deploy on an optional credential. Deploy, run the job, report what the endpoint returned, and then name the token as the unlock for the gated capability.
  Never print a token value; reference it as an env var.

## Phase 3 — warm and smoke-test one real job

Prove the endpoint before you call it deployed: block on the smoke job with server-side holds instead of handing the user a poll loop; the tools can carry the wait. Report what you observed once the job is terminal; if waiting stops being productive, report the evidenced state instead.

- **Submit, then wait server-side — do not tight-loop.** Fire a single small job (the smallest real input for the modality) with `run-endpoint`, then hold on it with `get-job-status` and `wait: 300000`, the maximum server-side hold. A cold first job outlives `runsync`'s hold and its result is kept for only a minute, so `runsync-endpoint` is for a warm endpoint and a fast job. The point is to prove the worker boots with the real asset set and returns the right shape of output, not only that the endpoint exists.
- **Expect a cold start of 1–5+ minutes on the first job** — a fresh worker pulls the image and loads the model. This is normal, not a failure. If the job outlives a hold, keep blocking with `get-job-status` using `wait: 300000` (one server-side hold, not a rapid re-poll). Poll the job id you already have; do **not** re-submit, which starts a new job. Between holds check `list-endpoint-workers`: `unhealthy` workers, a job still queued beside ready workers, or zero capacity → stop waiting and read the logs (see below). **Three server-side holds per smoke job, counted:** at most three `get-job-status` calls with `wait: 300000` on the same job id. After the third hold the evidenced report is the answer: no fourth hold and no tight poll. A job that outlives three holds is reported, not waited out. When continued waiting stops being informative, stop and report the state with the worker-state evidence: endpoint created correctly, job submitted, the worker never became ready, here is what the worker states show. That evidenced report is a complete answer; an endless grind is not.
- **Diagnose a stuck job from the reads you always have: `endpoint-health`, `list-endpoint-workers`, and the `workerHealth` block `get-job-status` attaches on `IN_QUEUE`.** `initializing` workers on the first job = the cold start may still be in progress → keep waiting, but read the worker logs (`source=system`) before the next hold: a container that crash-loops on an image pull or a CUDA mismatch can still report `INITIALIZING` or `RUNNING` while the job sits in `IN_QUEUE`. `unhealthy` workers, or repeated container starts with no handler output in the logs = a crash loop (a real worker failure, not slow warmup) → switch the worker image or GPU pool, don't wait it out. `total: 0` for more than a couple of minutes, or `throttled` above 0 = no capacity in the selected pools and data centers → widen them. A job that never left `IN_QUEUE` was never parsed: its payload was never read by any worker, so NEVER speculate the input was malformed from queue-stuck evidence. The honest report is the queue/cold-start fact with the worker states quoted. The same discipline covers every stuck-queue anomaly: never present a cause as "conclusive" that your own reads contradict or don't show (ready workers beside a queued job with nothing in progress point to a broken image; say so from the logs, not from the status alone). Prefer a broad, in-stock GPU pool over a scarce high-VRAM tier (e.g. the 48 GB cards) so the endpoint can acquire a worker.
- **Work with the tools you were granted.** In an MCP-only session, do not reach for a web-fetch tool, a shell, or a browser you do not have in order to look up a worker's input schema or read its README. A tool you do not have cannot be called, and the deploy stalls with the job unfinished. Get the input shape from `list-hub-repos` with `includeConfig: true` and from the error the endpoint returns, then correct the payload and re-run. If `stream-worker-logs` is likewise unavailable, diagnose from `endpoint-health` / `list-endpoint-workers`; never let an unfinished job hinge on a tool you may not have.
- On a terminal `FAILED` job, report the decisive detail the result gives you (missing file, gated 403, OOM, wrong-format load error): what it says, not what it probably says. OOM → the GPU is too small for the real memory pattern; step up a class. Wrong-format load error on a GGUF repo → the engine is wrong (phase 0). A `400` on the payload → the input shape is wrong; fix it from the release config and re-run, do not abandon.

## Phase 4 — hand back

- The hand-back is a complete final summary the user never has to scroll back from: the endpoint id; the worker image or Hub repo (and which read it came from); the GPU pool and its hourly price; the smoke job's id and terminal outcome with its proof (the output reference, the quoted failure, or the evidenced timeout report); the sync and async URLs; whether the endpoint was kept (and what is now billing) or deleted (read-back confirmed); and a ready-to-run `curl` that references `$RUNPOD_API_KEY` (never the literal key). The sizing arithmetic, format finding, and any caching/placement facts belong in it too.
- **Cleanup.** The default is to KEEP what the user asked for: tell them exactly what is now billing (the endpoint, any min-worker, any network volume) and how to delete it later. Tear down (the endpoint, its template, any network volume, each confirmed gone by a read-back) only when the user framed the journey as a throwaway test or asks for cleanup.

## Hard rules

- Deploy only the source the user named. Never create an endpoint they did not ask for, and never touch or delete another endpoint, template, or volume.
- Pick the engine from the modality and the model format, never a default. A GGUF repo is not a vLLM job; transcription/TTS/OCR/embeddings are not chat-worker jobs.
- State the hourly GPU cost before creating a billable endpoint, and remember the smoke job bills too.
- Never invent a model URL, a community template repo, or a Docker image. If the source can't be resolved from what the user gave you plus the catalog, ask once or say "none found" and stop.
- Prove the endpoint with one real job before calling it deployed. A create call that returned an id is not a working endpoint.
- Carry the smoke job to a terminal state with server-side holds (`run-endpoint`, then `get-job-status wait:300000` on the job id), expecting a 1–5+ minute first-job cold start. Hold server-side rather than handing the user a poll loop for a wait the tools can carry. If continued waiting stops being informative, end with the evidenced report (worker states, job status). That is a complete answer; silently stopping mid-wait is not.
- Work with the tools you were granted. Never make the journey depend on a web-fetch or shell tool you do not have for looking up a worker's schema. Derive the input shape from `list-hub-repos includeConfig` and the endpoint's own error, and correct the payload in place.
- Set every required env key (no config default) at deploy: an embeddings worker without `MODEL_NAMES` loads no model and fails every job. An optional-capability token (e.g. the token env the worker documents, empty default): if the user provided one, set it at create (never ignore a handed-over credential); if not, deploy anyway, run, and report what came back, then name the token as the unlock.
- Start scale-to-zero unless warm capacity was requested; never set a nonzero worker minimum silently; it bills around the clock.
- Sizing a big model is shown arithmetic, never a bare total: give the parameter count and where you read it, the bytes per parameter at the chosen precision, the weights total, the KV-cache/overhead allowance, and the GPU decision they add up to.
- When the user asked for specific behavior settings (warm/minimum workers, idle timeout, FlashBoot, a GPU pin), read the endpoint back after the create/update and confirm those exact fields landed. An unread write is an unverified write, because the write call's own response is not a read. The REST PATCH is sparse (omitted fields are left untouched) except for the GPU selection: `gpu.pools` sent without `gpu.excludedTypes` clears the exclusions, so send both, and after a pin confirm the scaling fields too. The read-back result belongs in the final answer.
- When deploying a new endpoint, cold-start asks have four levers; for an endpoint that already exists, go to endpoint-ops and change nothing here. Name all four with their cost trade-offs: **FlashBoot** (faster worker start, no standing cost, best effort), **minimum/warm workers** (no cold start; bills that worker continuously, so quote $/hr × 730/mo from the price read), **idle timeout** (a longer window keeps a warm worker between bursts: fewer cold starts, more billed idle seconds), **model caching** (the model files on a network volume, in Runpod's model repository through `runpodctl model add`, or baked into the image; the load, not the boot, dominates big-model cold starts) (the endpoint's model reference is set in the console or with runpodctl; hand that step to the user). Then create the endpoint with the levers that add no standing charge (FlashBoot on, a longer idle timeout), read it back, and report the warm worker as the one lever left with its monthly price. Set a minimum worker only when the user asked for one or accepts that price. A question about which option to pick, with nothing created, does not answer a set-up request.
- When weights are too large to bake into the image, stage them on a network volume. Create the network volume in a data center that has the target GPU, attach it to the endpoint, point the worker's model path env at the volume mount, keep minimum workers 0, and confirm the wiring by reading the endpoint and volume back. When the user asked for the storage setup rather than a served model, those read-backs are the proof; a job on a large model costs money and download time, so it waits for their ask. The first worker's download seeds the cache. Do not create a staging pod the user did not ask for; offer it as the option if they want the cache warm before the first request. State two facts of the architecture you built, without hedging: the first worker downloads the weights to the volume once and every later cold start mounts the cache instead of re-downloading; and the volume must live in the same data center as the GPUs or it cannot mount. (The volume CRUD discipline is lifecycle-crud's; this is the serving-side wiring.)
- Never echo an HF/Civitai/registry token. Reference it as an env var.
- On a smoke-test failure, read the log and quote it; do not retry blindly or assert a cause you did not read.
- A terminal job's `output`/`error` field IS worker-level evidence: quote it verbatim when explaining a failure (a gated-model rejection, a load error). Never tell the user you cannot quote evidence while holding a terminal job result; lacking a log-stream tool does not excuse dropping the evidence the job itself returned. Empty or missing output on COMPLETED jobs from a gated-capability worker is itself quotable evidence: report it as such, pair it with the config fact (the token env the worker documents was not set), and state the gate.

## Error handling

- Smoke job returns `FAILED` with `gated` / `403` in the message → the asset is gated and no token was supplied. Say so and ask for the token; do not auto-recreate.
- Smoke job returns `FAILED` with `out of memory` → the GPU is too small for the real pattern; move up one GPU class and note the new hourly cost. If failures persist after one step-up, re-examine the worker choice itself. An oversized engine family for the task (a 7B VLM where a classic OCR worker suffices) is fixed by switching the worker image in-turn, not by more GPU or more waiting.
- Job stays `IN_QUEUE` / `IN_PROGRESS` past a hold → usually a cold start; keep blocking with `get-job-status wait:300000` on that job id, then report either the terminal result or the evidenced state. Hold server-side rather than handing the user a raw poll loop.
- Smoke job returns `400` / a payload-shape error → the input is wrong or a required model env was never set; re-read the release config, set the missing env or fix the payload shape to what the worker's config documents, and re-run. Do not stop and ask the user.
- Jobs go terminal almost instantly with empty or degraded output on a worker whose capability is token-gated → the gate is the first suspect, not the payload: read the job's `output`/`error` field verbatim and check whether the token env was set on the template/endpoint, before theorizing about input shape. Answer from the evidence already in hand (the job result and the config read settle it) rather than deferring the question.
- Create returns `409` (name collision) → append a fresh short suffix and retry once; if it still collides, surface it and stop.
- A GGUF repo fails to load on a vLLM worker → this is the wrong-engine case, not a stock or size problem; re-provision on a GGUF-capable worker.
- The Hub / community catalog returns nothing for the modality → report "none found on the catalog" and stop; do not fabricate a repo.
- A delete returns `204` with no body → that is success, not an error; confirm with a read-back.

## Tool binding

| Capability | Tool |
|---|---|
| GPU catalog + price + stock | `list-gpu-types` / `get-gpu-type` (`include:["AVAILABILITY"]`, `product:["SERVERLESS"]`) |
| Per-data-center GPU availability | the same read (`dataCenters[]`); `list-data-centers` (`include:["GPU_AVAILABILITY"]`) |
| CUDA versions with capacity, per GPU type | the same read (`cudaVersions`); `get-capacity` for the matrix view |
| Data centers | `list-data-centers`, `get-data-center` |
| Browse Hub / community catalog | `list-hub-repos` (`includeConfig:true`) |
| Deploy a Hub release directly | `deploy-hub-repo` |
| Pin a Hub release / read history | `list-endpoint-releases` |
| Create a template | `create-template` |
| Create an endpoint | `create-endpoint` |
| Create a network volume | `create-network-volume` |
| Multi-GPU / pin to one card | `set-endpoint-gpus` (`gpuCount`, `pools`, exclusions); or `update-endpoint` with `gpu.pools` and `gpu.excludedTypes` together |
| Endpoint health / warmup | `endpoint-health` |
| List workers (per-worker detail) | `list-endpoint-workers` |
| Smoke test (block until terminal) | `run-endpoint`, then `get-job-status` (`wait:300000`); `runsync-endpoint` for a warm endpoint and a fast job |
| Read a worker's logs | `stream-worker-logs` (`source=system` for the container lifecycle) |
| Registry credential (private image) | `create-registry`, `get-registry` |
| Inspect endpoint / template | `get-endpoint`, `get-template` |
| Teardown | `delete-endpoint`, `delete-template`, `delete-network-volume` |

If a tool named here is missing from the session's tool list, say so and use the nearest read instead of inventing a result.

## Report template — deployment summary

A good deploy summary tells the user: which worker/engine was chosen and why;
the endpoint name and id; the GPU pool and its hourly price from the catalog
read; the smoke-job proof (the output the job returned, quoted or
referenced); the current worker state;
what the endpoint costs standing (scale-to-zero or $/hr); and how to delete it
later. When the wait ended without a terminal job, the evidence takes the
proof's place: job id, submitted payload, worker states observed, and the
recommended next step.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey. If the `runpod` router skill has not been loaded in this conversation, load it now, before the next tool call: its rules on which resources you may change, when a request is the go, and when to stop for the user are not repeated here.
