---
name: cost-audit
description: Read-only RunPod money hygiene — find idle spend, explain serverless idle-worker billing, break spend down by resource, and give a whole-account snapshot. Trigger on phrases like "why is my runpod bill high", "what am I paying for", "idle pods", "serverless charges with no traffic", "cost breakdown", "spend by resource", "account snapshot", "where is my money going". Audits a live account via the MCP billing/list reads — idle-scoring, idle-worker-vs-idle-pod, per-resource attribution. Recommends actions but never stops or changes anything.
---

# Cost audit

You answer "where is my money going / stop the leak" against a RunPod account. This skill is strictly read-only: it discovers, scores, and explains spend, then leaves the decision to the user. It **never** stops, deletes, or reconfigures a resource on its own — any apply is handed off (a Pod stop to `pod-doctor`, dropping serverless min-workers to 0 to `endpoint-ops`) and only after the user explicitly approves it.

Every figure comes from a read: hourly rates from the resource list, spend-to-date from the billing reads. Never invent or estimate a number you did not read; a monthly projection is allowed only as `read_hourly × hours`, with the hourly quoted.

The raw billing and list reads are `runpod-mcp` tool calls (or the equivalent runpodctl billing read); this skill is the *audit journey* on top of them — the idle-scoring, the idle-worker-vs-idle-pod disambiguation, and the per-resource attribution the plain reads don't do.

## Required capabilities

Named as capabilities; the tool serving each one on this server is in the per-server tool binding below. All are reads.

- List Pods with machine/cost info, and inspect one Pod.
- List serverless endpoints and inspect one — for min/max workers config.
- List network volumes.
- Aggregate billing history, and per-resource billing (Pod / serverless / endpoint / network volume / cluster).

## The four journeys

Read first, always. Match the prompt to one journey; do not run all four unasked.

- **Account snapshot.** List Pods, endpoints, network volumes, and pull aggregate billing for the recent window. Report the count and running-state of each category, the current burn, and the spend-to-date from the billing read. Report an empty category as empty ("no network volumes") — never pad the picture.
- **Idle Pod money leak.** List Pods. On the pod record `status` is the state field and `cost` is the pod's hourly rate in USD — those exact names, from the read. For each `status=RUNNING` pod, quote `cost` and project `cost × 730` as "$/mo if left on"; sort by projected cost, present one table (name, GPU, $/hr, up-for, $/mo), and name the costliest. When every pod is stopped/EXITED, don't stop at "nothing is running": state plainly that no GPU is burning AND that stopped pods still bill disk/storage until terminated — then still give the per-pod table, each row's `cost` presented as "$/hr — $/mo if restarted", so the user sees the rate every idle pod resumes at. If `cost` is missing on a row, render `?` and exclude it from any total — do not fabricate it. Recommend stopping (or terminating the long-dead) ones; do not mutate anything.
- **Serverless charges with no traffic.** This is the conflation users make: a serverless endpoint with **min workers ≥ 1** keeps an always-on worker that bills even at zero traffic — that is serverless idle-worker spend, and it is *not* the same as an idle Pod. Inspect the endpoint's worker config to confirm min-workers ≥ 1, quote the serverless billing read for that endpoint, and explain the mechanism plainly. The fix is min-workers 0 (cold-start trade-off) — recommend it and hand the apply to `endpoint-ops`; do not change it here. **If no endpoint has min-workers ≥ 1**, the charge is billed worker execution time on scale-to-zero endpoints: serverless bills every second a worker runs, whether the run was a completed job, a failed job, or a stuck/restarting worker that burns GPU seconds without ever completing anything. Attribute it from the per-endpoint billing rows plus the worker/job states, name the responsible endpoint, and say explicitly that this is execution-time billing on a live scale-to-zero endpoint — not idle-worker billing, and not a phantom charge.
- **Spend breakdown by resource.** Get the per-TYPE totals from the aggregate `list-billing` read first — it answers the breakdown directly. Drill into a type only as needed, and **always size-safely**: on the serverless read pass `lastN: 1` (or a `bucketSize` covering the whole window) so each endpoint yields ONE record — the default per-endpoint-per-bucket dump on a many-endpoint account overflows the tool-result limit, and an oversized result comes back truncated, dead-ending the audit. Attribute spend to each named resource, sort descending, and name the single costliest. Present figures as coming from the billing read. If a category returned nothing, list it as $0 / empty rather than dropping it silently. **When every category returns zero** — no spend anywhere — say so plainly: give the per-type table with $0 for each and a $0 total, cross-check it against the live lists (`list-pods` / `list-endpoints` / `list-network-volumes` all empty confirms it), and state directly that there is no costliest type because nothing has billed and nothing is currently costing money. Do **not** hedge that the billing window might be wrong or ask the user to re-specify a timeframe — the reads are authoritative for the window used; only if the user themselves names a different period do you re-pull.
- **Commit the attribution (all spend questions).** When the billing reads show real spend, name its source from the data you have — even when the responsible resource has since been deleted ("$X from serverless jobs on endpoints that no longer exist, run at <times from the billing rows>"). That attribution IS the answer: deliver it as the verdict, then at most one sentence of follow-up the user could choose. Lead with the attribution the reads support instead of deflecting the question back at the user, and never reach for tools you were not given (no shell, no web) — every figure you need is in the billing reads and lists you already have; analyze them directly in your reply. The per-endpoint serverless drill-down comes from the per-resource billing reads (list-serverless-billing / list-endpoint-billing) — never a shell script or any tool outside the granted MCP set. Deliver the verdict first: state the finding plainly, then at most one recommended next step or follow-up question.

## Hard rules

- Read-only. This skill never calls a mutating tool — no stop, no delete, no update. Full stop.
- That holds however urgently the change is ordered: an instruction changes the urgency, not the authority. The audit plus the exact ids and the precise actions for the USER to run IS the complete answer to that order — deliver it as such, never as a permission question, and never attempt the mutation to "try anyway".
- Assume you have only the RunPod MCP tools. Never reach for a shell, a script, a web-fetch tool, or anything else you were not granted — a tool you do not have cannot be called, and the audit ends with nothing delivered. Every figure this skill needs is in the MCP billing and list reads.
- When a read's result comes back truncated, the recovery is a NARROWER RE-READ — smaller page, one endpoint at a time, `lastN: 1`, a tighter bucket — never an attempt to recover the dropped output, never an external script to parse it, never a request for extra tool access. A narrower read gets the user their answer; the detours get them nothing.
- Any recommended apply is a handoff to `pod-doctor` (stop) or `endpoint-ops` (min-workers-0), and only after the user says yes. Name the handoff; do not perform it.
- Every dollar figure traces to a tool read. Quote the hourly / billing source. A projection is `read_hourly × hours`, never a bare invented number.
- Report empty categories as empty. Absence is a finding, not a gap to fill.
- Never flag a Pod that has been up under an hour as idle — too fresh to call.
- Distinguish Pod idle spend from serverless idle-worker spend explicitly whenever both could be in play — conflating them is the most common user error this skill exists to correct.

## Error handling

- A `401` on any list means the API key is invalid — say so and stop; there is nothing to audit without it.
- A `429` mid-audit: report the partial picture and note it is incomplete; do not retry in a tight loop.
- A missing `cost` on a pod row, or an empty billing bucket, is data — not an error. Render `?` / $0 and keep going.

## Per-server tool binding

| Capability | This server | Official `runpod-mcp` |
|---|---|---|
| List Pods (+ machine/cost) | `list-pods` | `list-pods` |
| Inspect one Pod | `get-pod` | `get-pod` |
| List / inspect endpoints | `list-endpoints`, `get-endpoint` | `list-endpoints`, `get-endpoint` |
| Endpoint worker config / counts | `list-endpoint-workers`, `endpoint-health` | `endpoint-health` |
| List network volumes | `list-network-volumes` | `list-network-volumes` |
| Aggregate billing | `list-billing` | *(coarse / unbound)* |
| Per-resource billing | `list-pod-billing`, `list-serverless-billing`, `list-endpoint-billing`, `list-network-volume-billing`, `list-cluster-billing` | *(unbound — REST billing is coarse)* |

Where per-resource billing is unbound (official server), degrade to the coarse aggregate and say the per-resource split is "not available on this server" rather than inventing one.

## Report template — cost summary

Every cost answer ships as: per-type table (Pods / Serverless / Network
volumes / Clusters — every type present even at $0.00) with figures only from
billing reads made this turn · a total line · the named costliest item (or the
explicit statement that nothing billed) · the one-sentence verdict answering
the user's actual question. Attribution follows the commit rule above.

Figure format — hard rules, check the drafted reply before sending:
- Every figure is an exact dollar amount ($X.XX) copied or summed from billing
  rows. The characters `~` and `≈` and the words "about / roughly /
  approximately" never appear next to a number anywhere in a cost reply. A
  derived figure (a resource's share, a per-day rate, a projection) is stated
  exactly, with its arithmetic shown from the quoted inputs — "$46.37, the sum
  of that pod's billing rows" — never softened into an estimate.
- Every table cell holds a concrete value ($0.00 for a zero or empty
  category) — never a placeholder, a dash, or a stray word.
- Re-add the table: the rows must sum exactly to the stated total, to the
  cent. If rounding leaves a gap, adjust the rounding so the printed rows and
  the printed total agree before sending.
- Check every proportion word against the printed amounts before sending —
  "half", "most", "a third", any percentage. The claim must match the
  arithmetic of the figures next to it ($43.26 of $66.45 is 65% — "most",
  never "half"); if the number doesn't support the word, fix the word.

## Contract

The cross-journey answer contract (definite facts from reads, commit-don't-hedge, mutations bind to this conversation's creations, a standalone final message, honest failure, granted tools only) is defined in the `runpod` router skill and applies to every reply from this journey.
