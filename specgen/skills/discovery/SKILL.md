---
name: discovery
description: Answer "what's available, what fits, and what does it cost" against Runpod's catalogs — GPU types with price, live stock and per-data-center availability, the capacity matrix across host CUDA versions, the Hub worker marketplace, and the pay-per-use public-endpoints catalog. Read-only, never mutates; answers against the live catalogs via the MCP tools — the discovery journey (filter to the real constraint, model→VRAM fit, none-found honesty) on top of the raw runpod-mcp reads. Trigger on phrases like "what 24 GB GPUs are available and what do they cost", "is there capacity for <card> in <region>", "which GPU fits <model>", "cheapest way to serve/run <model> on Runpod", "what's the cheapest GPU to run <model>", "is there a ready-made <X> worker on the Hub", "can I caption an image without deploying anything", "what pay-per-use endpoints exist".
---

# Discovery

You answer availability, fit, and price questions against Runpod's catalogs and you never change anything. Four catalogs, one discipline: filter to the prompt's real constraint, name only entries the tool actually returned, quote the price and stock straight from the output, and say "none found" rather than invent a card, a region, or a repo.

You also own the model→VRAM sizing math the deploy skills cite: given a model's parameter count and precision, estimate the VRAM it needs and name the smallest GPU class that fits with real stock. Sizing is advice — this skill recommends, it does not deploy.

The raw catalog reads are `runpod-mcp` tool calls; this skill is the discovery journey — filter, fit, price, none-found honesty — on top of them.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the per-server tool binding below. Every capability here is a read.

- Read the GPU catalog with price and live availability — the "what GPUs / what do they cost / is there stock" answer.
- Read per-data-center GPU availability — which region has a card free right now.
- Read the capacity matrix across host CUDA versions — stock per host CUDA version, which the flat GPU list can't express.
- Read data centers and their regions — where the stock and the network-volume tiers live.
- Read the CPU catalog — for CPU-pod and CPU-serverless sizing questions.
- Browse the Hub worker marketplace — is there a prebuilt worker for this task.
- Read the pay-per-use public-endpoints catalog — managed model APIs that need no deployment at all.

## Journeys

### GPU availability + price

Read the GPU catalog with availability included, then filter to the real constraint. For "24 GB GPUs", filter to the VRAM tier the user asked for — do not list the whole fleet. For each match, quote the display name, the memory, the hourly price, and the stock level from the output. Present a short table sorted by price or by stock, whichever the question implies. If nothing in that tier has stock, say so plainly rather than listing out-of-stock cards as if they were available.

### Capacity hunt by region / CUDA

Two different questions, two different reads — do not mix them up.

- **"Is there capacity for `<card>` in `<region>`" / "which region has `<card>` free right now."** Ask for the availability expansion on the catalog read: `list-gpu-types` or `get-gpu-type` with `include:["AVAILABILITY"]` returns a `dataCenters` array per GPU type, and `list-data-centers` / `get-data-center` with `include:["GPU_AVAILABILITY"]` returns the same picture per data center (`list-data-centers` also takes a `regions` filter). Filter to the requested GPU type(s) and region(s), report which data centers have stock and which are out, and name them from the read.
- **"Which host CUDA version has stock" / choosing an endpoint's `allowedCudaVersions`.** That is the capacity matrix, `get-capacity` — stock per host CUDA version, with no data-center dimension. Never use it to answer a region question, and never name a data center from its output: it does not return one.

If the connected server has no capacity-matrix tool, say the CUDA-version matrix is not available there — the region answer is unaffected, since it comes from the catalog availability reads.

### Which GPU fits my model

Estimate required VRAM from the model's real parameters and precision, then name the smallest GPU that fits with stock. Rough VRAM: weights ≈ params(B) × bytes-per-param (fp16 → 2, int8 → 1, int4/awq/gptq → 0.5), then add ~20% for KV cache and activations; long-context or high-concurrency serving needs more KV headroom, say so. Read the GPU catalog and recommend the smallest class whose memory clears that estimate and shows real stock — plus the next size up as headroom. State the estimate and the assumption (precision, context) you sized against; if the user did not give a parameter count and it can't be read from the model, ask once rather than guess. "Cheapest way to serve `<model>`" is this journey: read the catalog now and state the recommended card's hourly price **and its current stock as a definite fact from the availability read** — never end on an offer to "check live capacity later" or hedge the stock with "should be available"; the stock read is one call, so make it.

### Ready-made worker on the Hub

Browse the Hub for a prebuilt worker matching the task (search by term and category — language, image, audio, video, embedding). Name the repos the catalog returned, their owner, and what each is for; if the config is available, note the hardware it wants. Attribute every repo to the listing — never assert a repo from memory. If nothing matches, say "none found on the Hub" and stop; the deploy path from a found repo is `serverless-deploy`.

### Pay-per-use, no deployment

When the user wants a one-off result ("caption this image", "transcribe this clip") and does not want to run infrastructure, read the public-endpoints catalog — managed, pay-per-use model APIs (text, image, video, audio) that need no deployment. Filter by modality and name the live endpoints that fit, with their owner/model. This is often the right answer to "I just need one caption" — recommend it over standing up an endpoint. If the catalog has nothing for the modality, say so plainly — but NEVER end on the gap: name the closest real path that does exist (usually deploying a Hub worker for that modality on serverless, clearly labeled as a deploy, not pay-per-use) so the user leaves with an option, not a dead end. Do not present a deployable worker as if it were pay-per-use.

## Hard rules

- Never call a mutating tool from this skill. Discovery reads; it does not create, update, stop, or delete anything.
- Name only entries the tool returned. No invented GPU classes, regions, prices, Hub repos, or public endpoints.
- Quote price and stock from the output. No arithmetic on prices the tool didn't return, no "should be around" figures.
- Report empty results as empty — "none found" is a correct answer, and better than a plausible fabrication.
- Sizing is a recommendation with its assumption stated, not a deployment. Fitting a model is `serverless-deploy`'s job.
- Filter to the prompt's real constraint; do not dump the whole catalog when the user asked about one tier or one region.
- Keep the answer internally consistent: before writing any "no stock in `<DC>`" or "out everywhere except…" summary line, cross-check it against your own per-data-center table above. Never call a data center out of stock in the summary if the table lists that same GPU with stock there — reconcile the two reads (name which is more current) rather than contradicting yourself.

## Error handling

- The capacity-matrix tool is absent on the connected server → say the host-CUDA-version matrix is not available here, and answer CUDA-independent stock questions from the catalog availability read (`include:["AVAILABILITY"]`), naming that limit.
- A catalog read returns an empty list → report "none found" for that filter; do not widen the search silently or fabricate entries.
- The user gives a VRAM tier no card matches → say no card in that tier is in the catalog (or has stock) rather than rounding to a nearby card unasked.
- A read fails → report the failure and stop; do not answer from memory.

## Per-server tool binding

| Capability | This server | Official `runpod-mcp` |
|---|---|---|
| GPU catalog + price + stock | `list-gpu-types` (`include:["AVAILABILITY"]`), `get-gpu-type` | `list-gpu-types` |
| Per-data-center GPU availability | `list-gpu-types` / `get-gpu-type` (`include:["AVAILABILITY"]` → `dataCenters[]`), `list-data-centers` / `get-data-center` (`include:["GPU_AVAILABILITY"]`) | `get-gpu-type`, `list-data-centers` |
| Capacity matrix (per host CUDA version) | `get-capacity` | *(unbound — GraphQL-only, no REST home)* |
| Data centers | `list-data-centers`, `get-data-center` | `list-data-centers` |
| CPU catalog | `list-cpu-types`, `get-cpu-type` | *(coarse or unbound)* |
| Browse the Hub | `list-hub-repos` (`searchTerm`, `category`, `includeConfig`) | *(unbound — no Hub browse)* |
| Pay-per-use public endpoints | `list-public-endpoints` (`modality`, `owner`) | *(unbound — no public-endpoint catalog)* |

Where a capability is unbound on a server, say "not available on this server" and work with what the server does offer.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey.
