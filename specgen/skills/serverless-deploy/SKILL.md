---
name: serverless-deploy
description: Bring any source — a HuggingFace repo, a ComfyUI workflow, a Hub release, a custom container image, a GGUF repo, a Civitai asset, or a community template — to a proven Runpod Serverless endpoint. Deploys an existing source through the Runpod MCP tools; code-first Python deploys (the runpod-flash dev loop) are outside this bundle's scope. Trigger on phrases like "deploy <owner/name>", "serve this model", "make this a serverless endpoint", "ship this ComfyUI workflow as an API", "deploy from the Hub", "run my custom handler image", "GGUF endpoint", "this model is too big for one GPU", "whisper / transcription endpoint", "text-to-speech / voice-cloning endpoint", "speaker diarization endpoint", "OCR / document-extraction endpoint", "embeddings endpoint for semantic search".
---

# Serverless deploy

You take *any* deployable source and turn it into a working, queue-backed Serverless endpoint that you have actually proven with one real job — and you leave the user knowing exactly what now exists and what it bills. The spine never changes: read the source, decide the engine and the hardware, provision, warm, smoke-test one real job, hand back the URL and a `curl`, state what is billing. Tear down only when the user framed the deploy as a throwaway test or asks for cleanup.

Two decisions are yours to make without being told, and getting them wrong is the usual failure: the **engine family** (which worker image is correct for this modality and model format) and the **provisioning path** (bake weights into the image vs download-on-start vs stage on a network volume, each with a different cold-start cost). Size hardware from the model's real metadata, never a guess. When several suitable workers exist for the modality, prefer the smallest, most-proven image for a smoke-able deploy — a giant image turns the first job into a many-minute cold-start lottery; the smoke test's job is proof of the journey, not maximal quality. Name the trade-off if the user's request implies a heavier engine. Creating an endpoint is billable — state the hourly cost of the GPU class before you create it, and remember a smoke job costs real money.

For code-first Python — writing endpoint functions in a project and iterating with Runpod's Python dev loop (runpod-flash) — this MCP-only bundle has no path: say so plainly instead of improvising one. This skill deploys an existing source (Hub repo, container image, ComfyUI workflow, Hub release) to an endpoint through the MCP tools.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the per-server tool binding below. This skill reads the catalog before it creates, and creates only what the user asked to deploy.

- Read GPU catalog + price + live stock, per-data-center availability, and the host-CUDA-version capacity matrix — sizing and stock (delegate the sizing math to `discovery`).
- Browse the Hub worker catalog, with the release config — to find a prebuilt worker or a community template and read its hardware/env schema.
- Deploy a Hub release directly as an endpoint — the one-call Hub path.
- Create a template (image, disk, ports, env, registry, mounts) — the reusable worker preset.
- Create a Serverless endpoint (GPU pools, worker min/max, scaler, data centers, network volumes).
- Create a network volume — to stage large weights in a GPU-co-located data center.
- Pin GPUs / set GPU count per worker — multi-GPU and SKU selection the create call can't express.
- Read endpoint health and list workers — warmup and readiness, and the cold-start-vs-crash-loop signal (`initializing` vs `unhealthy`).
- Submit a synchronous or async job and block on it — the smoke test (`runsync-endpoint wait:300000`, then `get-job-status wait:300000` on the job id until terminal).
- Read a worker's logs *when that tool is available to you* — model-load / crash evidence; when it is not, `endpoint-health` + `list-endpoint-workers` give the worker-health counts that already distinguish a cold start from a crash-loop.
- Delete the endpoint, template, and any network volume — teardown of everything created.

## Phase 0 — identify the source and pick the engine (unprompted decision)

Read the source the user gave you and classify it. The engine family follows from the modality and the model format, not from a default. Never serve a non-text-generation task on a vLLM or ComfyUI worker.

| Source / modality | Correct engine family | Worker image kind |
|---|---|---|
| Text-generation LLM, `safetensors` weights | vLLM or SGLang | `runpod/worker-v1-vllm` (or SGLang worker) |
| Text-generation LLM, `GGUF` quantized weights | llama.cpp / Ollama | a GGUF-capable worker — **not** vLLM |
| Image/diffusion `workflow.json` | ComfyUI | `runpod/worker-comfyui` |
| Speech-to-text (transcription) | Whisper / faster-whisper | a Whisper worker, not an LLM worker |
| Text-to-speech / voice cloning | Chatterbox / XTTS / Kokoro | a TTS worker |
| Speaker diarization | pyannote / a diarization pipeline | a community/Hub diarization worker |
| OCR / document extraction | PaddleOCR / DeepSeek-OCR / docling | an OCR worker, not a VLM chat worker |
| Text embeddings | Infinity / text-embeddings-inference / sentence-transformers / BGE | an embeddings worker |
| A custom handler you were given | your own image | a custom container image |

- **Format detection.** Inspect the repo's files before choosing. `*.safetensors` / `*.bin` → vLLM/SGLang. `*.gguf` → a llama.cpp/Ollama worker; deploying a GGUF repo on worker-vllm is the classic wrong-engine mistake — vLLM will not load it. State the format you detected and the engine it implies in the final message — the detection is part of the answer, not just the decision.
- **OCR sizing.** For an OCR/document-extraction smoke deploy, default to a classic lightweight OCR worker (the PaddleOCR/EasyOCR/docling class, 16–24 GB). A VLM-based OCR (7B+ params) is a big-model deploy — size it like one (48 GB class) or don't pick it for a smoke test.
- **Community-template source.** When the modality has no first-party Runpod worker (e.g. speaker diarization), browse the Hub / public catalog for a **community (non-Runpod)** template that serves it. Attribute provenance to the catalog entry you actually found — name the repo and its owner from the listing, never assert a repo from memory. Once you have found a fitting worker, **deploy it and run the clip** — do not stop at "I found X," and do not block on a credential the config makes optional (see the runtime-optional-token rule in phase 2); ask for the capability in the job input (a diarization worker takes `diarization: true`). Only if the catalog returns nothing that fits do you say "none found" and stop; never invent a repo name or a Docker image.
- **Custom image.** When the user brings their own handler image, that image *is* the engine. After the deploy, read the worker states (`list-endpoint-workers` or `endpoint-health`) and report what you observed — for a custom image the workers' observed health IS the deliverable: one completed job does not show a crash-looping sibling worker, and a crash-looping custom image is called failing, never glossed. If it is in a private registry, the endpoint needs a registry credential (create/reference it — see `lifecycle-crud`); never echo the registry password. For a load-balancer (custom-HTTP, direct-routing) endpoint rather than the queue, the cardinal rule is that the worker must serve HTTP on a port the template exposes AND answer the load balancer's health path — `HEALTH_CHECK_PATH` if the worker sets that env, `/ping` otherwise. Miss either and workers never pass health, so the endpoint looks stuck with zero ready workers; the endpoint read returns the exact health URL being polled. The endpoint type is also immutable after create.

## Phase 1 — size the hardware (read the catalog, cite `discovery`)

Delegate the params×precision + KV/overhead VRAM math to `discovery`; this skill applies its result to a real GPU pick.

- Read the model's real metadata (parameter count, precision, and for diffusion the checkpoint/LoRA/VAE asset sizes). Do not size from the repo name alone when the config is readable.
- Pick the smallest GPU class whose VRAM fits, then confirm live stock from the GPU-availability read — `include:["AVAILABILITY"]` also gives the per-data-center picture when the endpoint needs a specific DC, and the capacity matrix adds the host-CUDA-version dimension when a CUDA floor is in play. Never create into a GPU class with no stock — a scale-to-zero endpoint that can never acquire a worker looks deployed but never runs.
- **Multi-GPU when one card can't hold the model.** When required VRAM exceeds the largest single card you can get with stock, set GPUs-per-worker > 1 and enable tensor parallelism in the worker env (e.g. the vLLM worker's tensor-parallel setting = GPU count). State plainly that you are going multi-GPU and why (the model does not fit on one card), and that multi-GPU workers cost proportionally more per hour. Before committing, price the alternative in the answer: quote the largest in-stock single card (its VRAM, live stock, $/hr) against the multi-GPU pick — a 2×80 GB decision that never names the in-stock 180 GB card is unjustified sizing.
- **Pin the pool on Hub deploys.** `deploy-hub-repo` inherits the release's GPU pool list when `gpuIds` is omitted — which can silently acquire a top-tier card for a task a 24 GB card serves, at several times the hourly rate. Pass `gpuIds` from YOUR sizing decision on every Hub deploy unless the release config pins exactly the pool your sizing chose.
- **CPU serverless (footgun).** A CPU endpoint cannot be created through the MCP `create-endpoint` tool — it requires a `gpu.pools` selection. A CPU serverless endpoint must be created via the REST/GraphQL `instanceIds` path or runpodctl; say that plainly rather than forcing a GPU pool onto a CPU workload.
- **State the cost.** Before creating, quote the chosen GPU's hourly rate (×GPU count) from the catalog read. Creating the endpoint and running the smoke test both bill.

## Phase 2 — provision

Two provisioning paths; choose by source.

- **Hub release.** If the source is a Hub repo, deploy its listed release directly (one call). Read the release config first (hardware requirements + env schema) so you pass only env keys the release accepts, and so you know its GPU/disk defaults. To reproduce a known-good build, pin the exact release rather than "latest".
- **Everything else.** Create a template that names the engine image, the disk size, the ports the worker exposes, and the env (model id, engine settings, tokens); then create the endpoint referencing it. Start scale-to-zero (min workers 0) unless the user asked for warm capacity — a nonzero minimum is an always-on billed worker.
- **Provisioning path and cold start.** Bake-into-image = fastest cold start, biggest image; download-on-start = small image, slow first request per new worker; **network volume** = weights staged once in a GPU-co-located data center, mounted read-only, so new workers skip the download. Choose a network volume when weights are large (roughly > 30 GB) or shared across workers; size it to the real asset total with headroom, create it in the same data center you pin the endpoint to (see `lifecycle-crud`), and say which path you took and its cold-start consequence.
- **Multi-region / HA (no auto-sync).** For a multi-region endpoint you attach one network volume per data center; these per-DC volumes do **not** auto-sync — you replicate data across them yourself (e.g. an `aws s3` sync between the volumes' S3 endpoints), or each region serves stale or missing weights.
- **Required env, gated weights, and runtime-optional tokens.** Read the release/worker config (`includeConfig: true`) and SET every required env key that has no default before you deploy — e.g. an embeddings worker's `MODEL_NAMES` (`BAAI/bge-small-en-v1.5`); deployed without its model env a worker loads nothing and 400s every job. For a gated HuggingFace repo whose *weights* 403 without a token at download time, pass the token in env, and if the user gave none, say the download will 403 and ask — do not deploy a build that cannot fetch its weights. A token needed only for an **optional runtime capability**, one whose config default is empty (a diarization worker's `HF_TOKEN`), branches on one check you make FIRST: did the user provide a token (pasted in the request, set in the environment, or named as available)?
  - **Token provided → using it is the job.** Set it as the worker env var at create (`HF_TOKEN` for a diarization worker), say that you configured it (by env-var name, never the value), and expect the gated capability to work. Never deploy without wiring a credential the user handed you.
  - **No token → deploy anyway.** The deploy is NOT conditional on the token: don't park the whole deploy on an optional credential. Deploy, run the job, report what the endpoint actually returned, and then name the token as the unlock for the gated capability.
  Never print a token value; reference it as an env var.

## Phase 3 — warm and smoke-test one real job

Prove the endpoint before you call it deployed: block on the smoke job with server-side holds instead of handing the user a poll loop — the tools can carry the wait, so let them. Report what you observed once the job is terminal; if waiting stops being productive, report the evidenced state instead.

- **Submit through the sync path and wait server-side — do not tight-loop.** Fire exactly one real, small job (a short prompt, a 512px few-step image, one short audio clip, one page, one sentence to embed) with `runsync-endpoint` and `wait: 300000`, the maximum server-side hold. The point is to prove the worker boots with the real asset set and returns the right shape of output — not just that the endpoint exists.
- **Expect a cold start of 1–5+ minutes on the first job** — a fresh worker pulls the image and loads the model. This is normal, not a failure. If the job outlives the hold and `runsync` returns a non-terminal status with a job id, keep blocking with `get-job-status` using `wait: 300000` (one server-side hold, not a rapid re-poll). Poll the job id you already have — do **not** re-submit `runsync`, which starts a new job. Between holds check `list-endpoint-workers`: `unhealthy` workers or zero capacity → stop waiting immediately (see below). When continued waiting stops being informative, stop and report the state honestly with the worker-state evidence — endpoint created correctly, job submitted, the worker never became ready, here is what the worker states show. That evidenced report is a complete answer; an endless grind is not.
- **Diagnose a stuck job from the reads you always have: `endpoint-health`, `list-endpoint-workers`, and the `workerHealth` block `get-job-status` attaches on `IN_QUEUE`.** `initializing` workers = the cold start is still in progress → keep waiting. `unhealthy` workers = the container is crash-looping (a real worker failure, not slow warmup) → switch the worker image or GPU pool, don't wait it out (the classic Whisper/TTS tell). `total: 0` or throttled = no capacity on that GPU pool → widen it. A job that never left `IN_QUEUE` was never parsed — its payload was never read by any worker, so NEVER speculate the input was malformed from queue-stuck evidence; the honest report is the queue/cold-start fact with the worker states quoted. The same discipline covers every stuck-queue anomaly: never present a cause as "conclusive" that your own reads contradict or don't show (idle healthy workers beside a queued job is a platform anomaly you REPORT as observed, not a crash-loop you assert) — an unevidenced cause stated as fact fails the journey even when everything else was right. Prefer a broad, in-stock GPU pool over a scarce high-VRAM tier (e.g. the 48 GB cards) so the endpoint can actually acquire a worker.
- **Assume you have only the Runpod MCP tools.** Do not reach for a web-fetch tool, a shell, or a browser you were not granted to look up a worker's input schema or read its README — a tool you do not have cannot be called, and the deploy stalls with the job unfinished. Get the input shape from `list-hub-repos` with `includeConfig: true` and from the error the endpoint returns, then correct the payload and re-run. If `stream-worker-logs` is likewise unavailable, diagnose from `endpoint-health` / `list-endpoint-workers` — never let an unfinished job hinge on a tool you may not have.
- On a terminal `FAILED` job, report the decisive detail the result gives you (missing file, gated 403, OOM, wrong-format load error) — what it says, not what it probably says. OOM → the GPU is too small for the real memory pattern; step up a class. Wrong-format load error on a GGUF repo → the engine is wrong (phase 0). A `400` on the payload → the input shape is wrong; fix it from the release config and re-run, do not abandon.

## Phase 4 — hand back

- The hand-back is a complete final summary the user never has to scroll back from: the endpoint id; the worker image or Hub repo (and which read it came from); the GPU pool and its hourly price; the smoke job's id and terminal outcome with its proof (the output reference, the quoted failure, or the evidenced timeout report); the sync and async URLs; whether the endpoint was kept (and what is now billing) or deleted (read-back confirmed); and a ready-to-run `curl` that references `$RUNPOD_API_KEY` (never the literal key). The sizing arithmetic, format finding, and any caching/placement facts belong in it too.
- **Cleanup.** The default is to KEEP what the user asked for: tell them exactly what is now billing (the endpoint, any min-worker, any network volume) and how to delete it later. Tear down — the endpoint, its template, any network volume, each confirmed gone by a read-back — only when the user framed the journey as a throwaway test or asks for cleanup.

## Hard rules

- Deploy only the source the user named. Never create an endpoint they did not ask for, and never touch or delete another endpoint, template, or volume.
- Pick the engine from the modality and the model format, never a default. A GGUF repo is not a vLLM job; transcription/TTS/OCR/embeddings are not chat-worker jobs.
- State the hourly GPU cost before creating a billable endpoint, and remember the smoke job bills too.
- Never invent a model URL, a community template repo, or a Docker image. If the source can't be resolved from what the user gave you plus the catalog, ask once or say "none found" and stop.
- Prove the endpoint with one real job before calling it deployed. A create call that returned an id is not a working endpoint.
- Carry the smoke job to a terminal state with server-side holds — `runsync-endpoint wait:300000`, then `get-job-status wait:300000` on the job id — expecting a 1–5+ minute first-job cold start; hold server-side rather than handing the user a poll loop for a wait the tools can carry. If continued waiting stops being informative, end with the honest, evidenced report (worker states, job status) — that is a complete answer; silent surrender mid-wait is not.
- Assume you have only the Runpod MCP tools. Never make the journey depend on a web-fetch or shell tool you were not granted to look up a worker's schema — derive the input shape from `list-hub-repos includeConfig` and the endpoint's own error, and correct the payload in place. A tool you were not given is not a path.
- Set every required env key (no config default) at deploy — an embeddings worker without `MODEL_NAMES` loads no model and fails every job. An optional-capability token (e.g. a diarization worker's `HF_TOKEN`, empty default): if the user provided one, set it at create — never ignore a handed-over credential; if not, deploy anyway, run, and report what came back, then name the token as the unlock.
- Start scale-to-zero unless warm capacity was requested; never set a nonzero worker minimum silently — it bills around the clock.
- Sizing a big model is shown arithmetic, never a bare total: give the parameter count and where you read it, the bytes per parameter at the chosen precision, the weights total, the KV-cache/overhead allowance, and the GPU decision they add up to. "~146GB so 2×H200" without the components is an assertion, not sizing.
- When the user asked for specific behavior settings (warm/minimum workers, idle timeout, FlashBoot, a GPU pin), read the endpoint back after the create/update and confirm those exact fields landed — an unread write is an unverified write, because the write call's own response is not a read. The REST PATCH is sparse (omitted fields are left untouched), but the GPU-pin path is not: it runs through the GraphQL `saveEndpoint` mutation, which resets omitted settings to server defaults, so after a pin confirm the scaling fields too. The read-back result belongs in the final answer.
- Cold-start asks ("first message takes 40 seconds", "keep it snappy") have exactly four real levers — name all four with their cost trade-offs, then apply what was agreed: **FlashBoot** (faster worker start, no standing cost), **minimum/warm workers** (no cold start, bills that worker continuously — quote $/hr × 730/mo from the price read), **idle timeout** (a longer window keeps a warm worker between bursts — fewer cold starts, more billed idle seconds), **model caching** (weights on a network volume or baked into the image — the load, not the boot, dominates big-model cold starts).
- "Don't bake the weights into the image" / cache-on-volume asks are an architecture journey, not a smoke-test one: create the network volume in a data center that has the target GPU, attach it to the endpoint, point the worker's model path env at the volume mount, keep minimum workers 0, and run NO job unless asked. State two facts of the architecture you built, plainly and unhedged: the first worker downloads the weights to the volume once and every later cold start mounts the cache instead of re-downloading; and the volume must live in the same data center as the GPUs or it cannot mount. (The volume CRUD discipline is lifecycle-crud's; this is the serving-side wiring.)
- Never echo an HF/Civitai/registry token. Reference it as an env var.
- On a smoke-test failure, read the log and quote it; do not retry blindly or assert a cause you did not read.
- A terminal job's `output`/`error` field IS worker-level evidence — quote it verbatim when explaining a failure (a gated-model rejection, a load error). Never tell the user you cannot quote evidence while holding a terminal job result; lacking a log-stream tool does not excuse dropping the evidence the job itself returned. Empty or missing output on COMPLETED jobs from a gated-capability worker is itself quotable evidence: report it as such ('N jobs completed but returned no payload'), pair it with the config fact (the token env the worker documents was not set), and state the gate plainly.

## Error handling

- Smoke job returns `FAILED` with `gated` / `403` in the message → the asset is gated and no token was supplied. Say so and ask for the token; do not auto-recreate.
- Smoke job returns `FAILED` with `out of memory` → the GPU is too small for the real pattern; move up one GPU class and note the new hourly cost. If failures persist after one step-up, re-examine the worker choice itself — an oversized engine family for the task (a 7B VLM where a classic OCR worker suffices) is fixed by switching the worker image in-turn, not by more GPU or more waiting.
- Job returns `IN_QUEUE` / `IN_PROGRESS` past the sync wait → usually a cold start; keep blocking with `get-job-status wait:300000` on that job id, then report either the terminal result or the evidenced state. Hold server-side rather than handing the user a raw poll loop.
- Smoke job returns `400` / a payload-shape error (e.g. an embeddings worker's `TextEncodeInput` complaint) → the input is wrong or a required model env was never set; re-read the release config, set the missing env (`MODEL_NAMES`) or fix the payload shape (`{"input": {"model": "...", "input": ["..."]}}` for an Infinity/OpenAI-compatible embeddings worker), and re-run — do not stop and ask the user.
- Jobs go terminal almost instantly (well under a second of execution) with empty or degraded output on a worker whose capability is token-gated → the gate is the first suspect, not the payload: read the job's `output`/`error` field verbatim and check whether the token env was actually set on the template/endpoint, before theorizing about input shape. Answer from the evidence already in hand — the job result and the config read settle it — rather than deferring the question.
- Create returns `409` (name collision) → append a fresh short suffix and retry once; if it still collides, surface it and stop.
- A GGUF repo fails to load on a vLLM worker → this is the wrong-engine case, not a stock or size problem; re-provision on a GGUF-capable worker.
- The Hub / community catalog returns nothing for the modality → report "none found on the catalog" and stop; do not fabricate a repo.
- A delete returns `204` with no body → that is success, not an error; confirm with a read-back.

## Per-server tool binding

| Capability | This server | Official `runpod-mcp` |
|---|---|---|
| GPU catalog + price + stock | `list-gpu-types` (`include:["AVAILABILITY"]`), `get-gpu-type` | `list-gpu-types` |
| Per-data-center GPU availability | `list-gpu-types` / `get-gpu-type` (`include:["AVAILABILITY"]` → `dataCenters[]`), `list-data-centers` (`include:["GPU_AVAILABILITY"]`) | `get-gpu-type`, `list-data-centers` |
| Capacity matrix (per host CUDA version) | `get-capacity` | *(unbound — GraphQL-only, no REST home)* |
| Data centers | `list-data-centers`, `get-data-center` | `list-data-centers` |
| Browse Hub / community catalog | `list-hub-repos` (`includeConfig:true`) | *(unbound — no Hub browse)* |
| Deploy a Hub release directly | `deploy-hub-repo` | *(unbound — no Hub deploy)* |
| Pin a Hub release / read history | `list-endpoint-releases` | *(unbound)* |
| Create a template | `create-template` | `create-template` |
| Create an endpoint | `create-endpoint` | `create-endpoint` |
| Create a network volume | `create-network-volume` | `create-network-volume` |
| Multi-GPU / GPU-SKU pin | `set-endpoint-gpus` (`gpuCount`, `pools`) | *(unbound — no SKU pin; pools via `update-endpoint`)* |
| Endpoint health / warmup | `endpoint-health` | `endpoint-health` |
| List workers (per-worker detail) | `list-endpoint-workers` | *(coarse — `endpoint-health` only)* |
| Smoke test (block until terminal) | `runsync-endpoint` (`wait:300000`), `get-job-status` (`wait:300000`), `run-endpoint` | `runsync-endpoint` |
| Read a worker's logs | `stream-worker-logs` | *(unbound — no REST log stream)* |
| Registry credential (private image) | `create-registry`, `get-registry` | `create-registry` |
| Inspect endpoint / template | `get-endpoint`, `get-template` | `get-endpoint` |
| Teardown | `delete-endpoint`, `delete-template`, `delete-network-volume` | `delete-endpoint` |

Where a capability is unbound on a server, say "not available on this server" and work with what the server does offer.

## Report template — deployment summary

A good deploy summary tells the user: which worker/engine was chosen and why;
the endpoint name and id; the GPU pool and its hourly price from the catalog
read; the smoke-job proof (the actual output artifact: transcript text, audio
payload reference, extracted text, vector count); the current worker state;
what the endpoint costs standing (scale-to-zero or $/hr); and how to delete it
later. When the wait ended without a terminal job, the evidence takes the
proof's place: job id, submitted payload, worker states observed, and the
recommended next step.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey.
