---
name: cost-audit
description: >-
  Read-only Runpod spend audit: find idle spend, explain serverless billing when nothing seems to run, break
  spend down by resource type and by resource, and give a whole-account snapshot. Every figure comes from the
  MCP billing and list reads; it recommends actions and never stops or changes anything. Use when the user asks
  about their bill, what is costing money, what is running on the account, or tells you to stop or delete idle
  resources it did not name by id: the audit with ids and the user's own next steps is the answer. A resource
  the user names by id goes to pod-doctor or endpoint-ops, and the change is made.
metadata:
  concepts: [billing-record, pod-billing, serverless-billing, network-volume-billing, public-endpoint, credit-balance, endpoint-autoscaling]
---

# Cost audit

You answer where the money goes on a Runpod account and how to stop a leak. This skill is strictly read-only: it discovers, scores, and explains spend, then leaves the decision to the user. It **never** stops, deletes, or reconfigures a resource on its own. Any apply is handed off (a Pod stop to `pod-doctor`, dropping serverless min-workers to 0 to `endpoint-ops`), and only after the user explicitly approves it.

Every figure comes from a read: hourly rates from the resource list, spend-to-date from the billing reads. Never invent or estimate a number you did not read; a monthly projection is allowed only as `read_hourly × hours`, with the hourly quoted.

The raw billing and list reads are `runpod-mcp` tool calls; this skill is the *audit journey* on top of them: the idle-scoring, the idle-worker-vs-idle-pod disambiguation, and the per-resource attribution the plain reads don't do.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the tool binding below. All are reads.

- List Pods with cost info, and inspect one Pod.
- List serverless endpoints and inspect one, for min/max workers config.
- List network volumes.
- Aggregate billing history, and per-resource billing (pods, serverless endpoints, Public Endpoints, network volumes, clusters).

## The four journeys

Read first, always. Match the prompt to one journey; do not run all four unasked.

- **Whole-account view.** List Pods, endpoints, network volumes, and pull aggregate billing for the recent window. Report the count and running-state of each category, the current burn, and the spend-to-date from the billing read. Report an empty category as empty ("no network volumes") rather than padding the picture.
- **Idle Pods.** List Pods. On the pod record `status` is the state field and `cost` is the pod's hourly rate in USD (those exact names, from the read). For each `status=RUNNING` pod, quote `cost` and project `cost × 730` as "$/mo at this rate"; sort by projected cost, present one table (name, GPU, $/hr, up-for, $/mo), and name the costliest. When every pod is stopped/EXITED, don't stop at "nothing is running". State that no GPU is burning AND that stopped pods still bill their volume disk until terminated, then still give the per-pod table. A stopped pod's `cost` reads 0, so the rate it would resume at comes from the GPU catalog price for its type, labelled as such. If `cost` is missing on a row, render `?` and exclude it from any total; do not fabricate it. Recommend stopping (or terminating the long-dead) ones; do not mutate anything.
- **Serverless idle-worker spend.** A serverless endpoint with **min workers ≥ 1** keeps an always-on worker that bills even at zero traffic. That is serverless idle-worker spend, and it is *not* the same as an idle Pod. Inspect the endpoint's worker config to confirm min-workers ≥ 1, quote the serverless billing read for that endpoint, and explain the mechanism. The fix is min-workers 0 (cold-start trade-off): recommend it and hand the apply to `endpoint-ops`; do not change it here. **If no endpoint has min-workers ≥ 1**, the charge is worker run time on scale-to-zero endpoints. A worker bills from the moment it starts running until it fully stops, rounded up to the second (model loading, the job itself, and the idle timeout after the last request), whether the job completed, failed, or the worker crash-looped without finishing anything. Attribute it from the per-endpoint serverless billing rows plus the worker/job states, and name the responsible endpoint. Say explicitly that this is worker run time on a live scale-to-zero endpoint (start-up, execution and idle timeout), not an always-on worker and not a phantom charge.
- **Where the spend went.** Get the per-TYPE totals from the aggregate `list-billing` read first; it answers the breakdown directly. Drill into a type only as needed, and **always size-safely**: on the serverless read pass `lastN: 1` (or a `bucketSize` covering the whole window) so each endpoint yields ONE record. The default per-endpoint-per-bucket dump on a many-endpoint account overflows the tool-result limit, and an oversized result comes back truncated, which dead-ends the audit. Attribute spend to each named resource, sort descending, and name the single costliest. Present figures as coming from the billing read. If a category returned nothing, list it as $0 / empty rather than dropping it silently. **When every category returns zero** (no spend anywhere), say so. Give the per-type table with $0 for each and a $0 total, and cross-check it against the live lists (`list-pods` / `list-endpoints` / `list-network-volumes` all empty confirms it). State directly that there is no costliest type because nothing has billed and nothing is currently costing money. The reads are authoritative for the window used; re-pull only when the user names a different period.
- **Commit the attribution (all spend questions).** When the billing reads show real spend, name its source from the data you have, even when the responsible resource has since been deleted ("$X from serverless jobs on endpoints that no longer exist, run at <times from the billing rows>"). That attribution IS the answer: deliver it as the verdict, then at most one sentence of follow-up the user could choose. Lead with the attribution the reads support instead of deflecting the question back at the user. Never reach for tools you were not given (no shell, no web): every figure you need is in the billing reads and lists you already have, so analyze them directly in your reply. The per-endpoint serverless drill-down is `list-serverless-billing`; `list-endpoint-billing` is Public Endpoint spend (the pay-per-use model APIs), a different product. Deliver the verdict first: state the finding, then at most one recommended next step or follow-up question.

## Hard rules

- Read-only. This skill never calls a mutating tool: no stop, no delete, no update.
- For resources the user did not name: that holds however urgently the change is ordered: an instruction changes the urgency, not the authority. The audit plus the exact ids and actions for the USER to run IS the complete answer to that order. Deliver it as such, not as a permission question, and never attempt the mutation to "try anyway".
- Work with the tools you were granted. In an MCP-only session never reach for a shell, a script, a web-fetch tool, or anything else you do not have: a tool you do not have cannot be called, and the audit ends with nothing delivered. Every figure this skill needs is in the MCP billing and list reads.
- When a read's result comes back truncated, the recovery is a NARROWER RE-READ (smaller page, one endpoint at a time, `lastN: 1`, a tighter bucket). Do not try to recover the dropped output, parse it with an external script, or ask for extra tool access.
- Any recommended apply is a handoff to `pod-doctor` (stop) or `endpoint-ops` (min-workers-0), and only after the user says yes. Name the handoff; do not perform it.
- Every dollar figure traces to a tool read. Quote the hourly / billing source. A projection is `read_hourly × hours`, never a bare invented number.
- Report empty categories as empty. Absence is a finding, not a gap to fill.
- Never flag a Pod that has been up under an hour as idle; it is too fresh to call.
- Distinguish Pod idle spend from serverless idle-worker spend explicitly whenever both could be in play.

## Error handling

- A `401` on any list means the API key is invalid. Say so and stop; there is nothing to audit without it.
- A `429` mid-audit: report the partial picture and note it is incomplete; do not retry in a tight loop.
- A missing `cost` on a pod row, or an empty billing bucket, is data, not an error. Render `?` / $0 and keep going.

## Tool binding

| Capability | Tool |
|---|---|
| List Pods (with cost) | `list-pods` |
| Inspect one Pod | `get-pod` |
| List / inspect endpoints | `list-endpoints`, `get-endpoint` |
| Endpoint worker config / counts | `list-endpoint-workers`, `endpoint-health` |
| List network volumes | `list-network-volumes` |
| Aggregate billing (per type, one call) | `list-billing` |
| Per-resource billing | `list-pod-billing`, `list-serverless-billing` (serverless endpoints), `list-endpoint-billing` (Public Endpoints), `list-network-volume-billing`, `list-cluster-billing` |

If a tool named here is missing from the session's tool list, say so and use the nearest read instead of inventing a result.

## Report template — cost summary

Every cost answer ships as: per-type table (Pods / Serverless / Public
Endpoints / Network volumes / Clusters / storage, with every type present even at $0.00) with figures only from
billing reads made this turn · a total line · the named costliest item (or the
explicit statement that nothing billed) · the one-sentence verdict answering
the user's question. Attribution follows the commit rule above.

Figure format:
- Figures are exact dollar amounts from the billing and list reads.
- Table rows sum to the stated total.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey. If the `runpod` router skill has not been loaded in this conversation, load it now, before the next tool call: its rules on which resources you may change, when a request is the go, and when to stop for the user are not repeated here.
