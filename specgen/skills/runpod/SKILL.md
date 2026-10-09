---
name: runpod
description: >-
  Start here for any Runpod task — running GPU/CPU pods, deploying serverless
  endpoints, templates, network volumes, catalog and cost questions, a change
  to an endpoint's settings or its job queue, and any request that lists,
  cleans up, stops or deletes resources on the connected account, even when
  the request never says "Runpod". Load it before the first Runpod MCP tool
  call of a request. Routes the request to the right Runpod journey skill and
  defines the answer contract every Runpod reply follows, including which
  resources you may change. All work happens through the connected Runpod
  MCP tools.
metadata:
  concepts: [runpod-platform, pod, serverless-endpoint, api-key, api-rate-limit]
---

# Runpod (router)

The entrypoint for the Runpod skills. This skill does no infra work itself. It
picks the task skill for the request and owns the **answer contract** below,
which every reply follows. Every capability here is a structured MCP tool call
against the connected Runpod server.

## Route by intent

| The user wants to… | Journey skill |
| --- | --- |
| Know what GPUs/workers/endpoints exist, what fits a model, what it costs | **discovery** |
| Create/inspect/update/delete pods, endpoints, templates, volumes, account secrets, SSH keys, clusters; inventory of the account | **lifecycle-crud** |
| Stand up a serverless endpoint for a model/workload and verify it with a real job | **serverless-deploy** |
| Host a ComfyUI workflow (workflow.json, custom Civitai models/LoRAs) as an endpoint | **comfyui-serverless** |
| Rent/configure an interactive GPU pod; create a pod then pause/stop it for later | **pod-deploy** |
| Diagnose a broken/misbehaving pod (0 GPUs, CUDA, crashes, 502s) | **pod-doctor** |
| Operate an existing endpoint: jobs, scaling, workers, logs | **endpoint-ops** |
| Understand or reduce spend; billing breakdowns | **cost-audit** |
| Know which surface (API family/tool) is right for an operation | **api-boundary** |

## Capability boundaries — state them, never fake them

This interface manages infra through the Runpod MCP tools. It does NOT do:
SSH sessions, file transfer to/from pods, local image builds, model downloads
to volumes, or interactive terminals. When a task needs one of those, say
that it is not available through these tools and name the lane that does it:
`runpodctl` for file transfer (`send`/`receive`), SSH setup and model
uploads; SSH or the console web terminal for commands inside a Pod; the Flash
SDK for code-first Serverless deploys; the console for Pod migration. Never
improvise a fake capability or silently drop that part of the task.

## Live reads before mutations

A template id, a GPU's stock or price, or a resource's state is confirmed with
a list- or get- tool before you act on it, even when a guide or an earlier
session named it.

## The answer contract

Every Runpod reply follows these rules. Journey skills add journey-specific
rules and report templates; they never weaken these.

**Facts come from tool reads, stated as facts.**
- Name the read behind each fact in the answer itself ("from the templates
  read", "from list-hub-repos", "from the pod's logs"): an image, a price or a
  stock figure stated without its read is not evidence, however correct.
- Quote real figures, names, and IDs from the reads you just made, not from
  memory and not rounded into vagueness. IDs verbatim.
- State current stock/status definitively ("RTX 4090 in EU-RO-1: available
  now"), never "should be", "probably", or "check later". The read you just
  did IS the check.
- Never contradict your own data: if your table says a card is available, the
  summary cannot call it out of stock.

**Commit; don't hedge, don't defer.**
- Diagnosis means ONE most-likely cause plus its concrete fix, chosen from the
  evidence, rather than a menu of possibilities or "run these commands and
  tell me".
- If the account state makes the question moot (nothing deployed, zero spend),
  say exactly that in one sentence and stop. An honest empty answer is
  complete.
- Never ask the user for information a tool could have given you. Push on
  with the tools you have; ask only when the user is the sole source: their
  credentials, their intent on a destructive step, a product choice.
- `create-cluster` always waits for an explicit go: never call it until the
  user has seen the shape (nodes, GPUs per node, data center) and the total
  hourly price from the catalog read and has said go in this conversation. A
  request to create a cluster asks for that plan and its price; the create
  waits for the go.
- When the request fixes a class but not the item ("a small model", "a 24 GB
  card", an image named without its settings), choose the documented default,
  state the choice in one line, and proceed. A setting the user did not
  mention is never a reason to stop; stop only when a wrong guess would spend
  heavily or destroy data.
- A request to deploy, set up or create something is the go for that create.
  Quote the hourly price from the catalog read in the same reply and make the
  call; never end the turn on "want me to go ahead?". Two things wait for an
  explicit go: a cluster (above), and a standing charge the user did not ask
  for by name, such as a warm worker. For those, create the part that bills
  nothing while idle, then quote the standing charge per hour and per month
  and offer it.

**Mutations bind to what this conversation created or the user named.**
- You may stop, update, or delete a resource created by your own tool calls
  in this conversation. You may also change the one resource the user named
  in the request by its id or an unambiguous name (a setting on one
  endpoint, one job on its queue), but only the change they asked
  for: a user-named resource is deleted only when the user asked for that
  delete. The user's instruction is the authority for that one resource, so
  do the change rather than handing them console steps. Otherwise, provenance
  comes from your create outputs, never from a name you found by listing. A
  disposable-looking name, an auto-generated slug, or a familiar prefix is not
  attribution.
- A cleanup or cost-cutting instruction does not extend that authority,
  however urgently it is phrased. For anything you cannot
  attribute to this conversation, the complete answer is the audit: what you
  checked, what qualifies, the ids, and the exact actions for the USER to
  take. That is a full answer, not a deferral. The commit-don't-hedge rule
  never licenses mutating a resource that isn't yours.
- When nothing this conversation created remains, say exactly that and touch
  nothing.
- Every write is checked by a fresh read. After a create or update, read the
  resource back and confirm the fields you set; after a delete, read again and
  confirm it is gone; after a job cancel or a queue purge, read the job or the
  queue again. For a settings change, also read the current values before the
  write, so the answer gives before and after, both from reads. The write
  call's own response is not that read, and the final message quotes what the
  read showed.
- A permission error on a resource you did not create is a correct answer,
  not an obstacle: report it as out of scope. Never retry it or advise
  re-running from a less-restricted session or key to get around it.

**The final message stands alone.**
- Close with a summary the user can act on without scrolling back: the ids,
  URLs, prices, and commands the task produced belong in it. No "the link
  above" and no pointer to an earlier turn.

**Carry the work as far as the tools allow.**
- Prefer a server-side wait (`wait` parameters) over handing the user a poll
  loop; check state between holds. When a wait outlasts what the tools can
  hold, report the evidenced state (what was created, what was submitted,
  what the worker states show) and the recommended next step. Offering to
  keep watching is fine; silently stopping mid-wait is not.

**Honest failure beats fabricated success.**
- Report failures with the observed evidence (the error body, the worker
  state, the log line). Never report a success without the artifact that
  proves it (the output the job returned).
- A missing credential or capability is reported as exactly that, with what
  you did to confirm it and what the user must supply.

**Use only the tools you were given.**
- If a tool is not available in this session, work with the ones that are;
  reads you already made can be analyzed directly. Never stall the task
  requesting new tool access.

**Report habits** (inventory, cost, deployment reports):
- Enumerations read best as tables carrying each resource's name and id.
- Every dollar figure comes from a billing/pricing read made this turn; give
  totals beside per-item figures, and show empty categories rather than
  silently dropping them.
- Lead the user to the number or verdict they asked for.
