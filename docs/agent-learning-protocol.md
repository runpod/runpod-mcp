# Agent Learning Protocol — Phase 1 architecture

Working design doc for the three agent-feedback tool calls described in the
[Agent Feedback via Runpod MCP PRD](https://app.notion.com/p/3b4ff732fc3480e89ed5fda203a73841).
Status: P0 implemented on `feat/specgen-server` (tools `src/specgen/tools/alp.ts`, ingest `src/alp/`). Decisions here supersede the PRD where noted; the KV rate-limiter sections were superseded on 2026-09-03 — see Rate limiting.

## Phasing lives in Linear

[CON-1407](https://linear.app/runpod/issue/CON-1407/implement-stack-overflow-for-agents-on-runpod-mcp)
is the single source of phasing (P0-P3) and of which sub-ticket covers what. This
document is the design reasoning behind those decisions; it deliberately does not
restate the phase breakdown, so the two cannot drift.

Project: `[ROCK] CON_2026 Q3: Stack Overflow for Agents (ALP)`, Console Experience.

## Scope

Phase 1 of the PRD: three push tool calls in this MCP server, a store behind
them, and an internal path to read the data. Convex is the store (a Convex
deployment is already linked to the Vercel project hosting this server).

Phase 2 (agent-facing pull, consent model) and Phase 3 (published standard) are
out of scope, but the schema below reserves the fields those phases need so they
are not a migration.

## The three routes

The PRD specifies "same handler and same table underneath". That is right for
storage and wrong for behavior: the three tools converge on one write path and
diverge completely on what happens downstream. Treat them as one table with
three drains.

| Route | Tool                               | Drains to                                        | Duplicates are                  |
| ----- | ---------------------------------- | ------------------------------------------------ | ------------------------------- |
| RT1   | `report_feedback`                  | Internal review — dashboard, then Linear         | Signal — frequency is priority  |
| RT2   | `save_to_journal` / `read_journal` | The corpus, private per-identity first           | Confirmation — promotion signal |
| RT3   | `ask_question`                     | The void — recorded only, offline docs-gap queue | Coverage gap evidence           |

### RT1 — `report_feedback`

A bug-tracker inlet. The consumer is a human; the output is a Linear issue. Its
value is measured in fixes shipped, not in reads by other agents.

Cluster submissions by embedding similarity and **count** them — never merge
duplicates away. Forty agents hitting the same 400 is a P0 ranking.

Phase 1 drain is the internal query/dashboard (the PRD's M3), not a live feed. A
Slack echo was considered and is **not** planned: adoption is forced by the server
instructions, so volume will be high and mostly noise, and a per-row feed gets
muted inside a week. If one is ever added, it should fire on **cluster novelty** —
first occurrence of a cluster posts, subsequent hits reply and bump a count —
rather than per submission.

This route likely never needs to be agent-readable. An agent does not benefit
from reading that someone reported a bug; it benefits from the bug being fixed.

### RT2 — `save_to_journal` / `read_journal`

The corpus, and the only route that can poison. An agent that concludes a wrong
workaround and saves it will, in Phase 2, teach that workaround to every agent
that follows. Confidently stated and wrong is the failure mode, and models are
good at that.

So RT2 carries a verification state the other routes do not:

- Write freely, but store `verified` and default it to unverified.
- Never expose unverified content to other identities.
- Promotion signals, cheapest first: agreement between two independent
  submissions; no contradiction against the existing docs corpus; a human pass.

Phase 1 exposure is **private to the submitting identity only** — the submitter
can read back and write their own learnings, nobody else's. That gives the route
immediate value to its contributor without waiting on the Phase 2 consent model.

#### The tool pair

RT2 is the one route that is read/write in Phase 1, so it ships as two tools:

- `save_to_journal` — write an entry scoped to the calling identity.
- `read_journal` — read back that identity's own entries, nobody else's.

Naming diverges from the PRD's `save_learning` deliberately. "Journal" carries
the Phase 1 semantics the name needs to carry: it is _yours_, it is private, and
writing to it is not publishing. That is the property we most need the model to
infer without being told, and `save_learning` actively suggests the opposite.

The tension to accept: "journal" becomes a partial misnomer in Phase 2, when
opted-in entries become visible to other agents. The answer is that Phase 2 adds
a **separate** public search tool rather than renaming this pair — the private
journal keeps meaning exactly what it means today, and cross-identity search is a
different tool with different consent semantics. Renaming a tool agents have
learned to call is worse than having two.

### RT3 — `ask_question`

Decision (confirmed with the project lead): the question goes **into the void**.
It is recorded and nothing comes back. No generated answer, no skill matching, no
deferred reply.

The point is aggregation. A pile of questions agents actually got stuck on is a
prioritized work queue — for docs, for the official skills, and for spotting where
one model asks what another already answers. Generating a reply would destroy that
signal because it always produces something, whether or not the gap is real.

#### The response must say so explicitly

This is a correctness requirement, not politeness. An agent that gets a vague
acknowledgement will plausibly wait for something, poll, re-ask, or read the
silence as a tool failure and retry. An ambiguous ack is a false affordance the
model may structure its plan around.

So the tool result states, in the text: recorded, **no answer is coming**, do not
wait, do not retry, continue the task. Secondary line points at the official
Runpod skills as where to look instead — true regardless, and the agent still
needs somewhere to go.

Constraint to be honest about in that wording: **an MCP server cannot install a
skill into its client.** The pointer is an instruction for the agent or its human,
and it does not resolve the current turn.

#### Consequences

- **RT3 is pure altruism, by decision.** An answering `ask_question` would have
  been the one tool agents call out of self-interest rather than instruction. That
  is deliberately given up, so adoption is forced by the server instructions
  exactly as it is for RT1 and RT2.
- **No latency budget.** With nothing to compute before responding, RT3 is fully
  symmetric with the other two routes: fire the write, return a constant. This is
  the main reason skill matching stays out of Phase 1 — the hosted server is
  reaped at 60s and tool waits already clamp below that.
- **Coverage-gap detection is offline.** There is no per-request "did a skill
  match" column, so it is a review over accumulated questions. Clustering, which
  RT1 needs anyway, is what makes that review tractable.

Still worth recording per question: whether the same identity asked again
afterward, which is the cheapest proxy for "the void was not good enough."

## Ingest topology

`@runpod/mcp-server` is a **public npm package**. Anything in its `files` list is
readable by everyone who installs it, so the local stdio path cannot hold Convex
credentials or any other shared secret. There is no version
of "run the same store locally" that survives that constraint.

So both transports write through one hosted endpoint on the Vercel deployment:

```
stdio (local, public npm)  ──┐
                             ├─→ POST /api/alp/submit   (auth: caller's rp_ key)
hosted MCP (same Vercel)  ───┘        │
                                      ├─ resolve key -> identity
                                      ├─ courtesy scrub (authoritative scrub is sink-side)
                                      └─ Convex mutation    (server shared secret)
                                              └─ scheduled ingest:
                                                   scrub -> embed -> cluster -> classify
```

stdio already holds the caller's Runpod API key, so it can authenticate to the
ingest endpoint with a credential it already has. No new secret ships in the
package.

This also gives the single-caller property the Convex access rule above depends
on, and it means schema changes land in one place rather than needing an npm
release to reach local users.

## Enablement and local testing

### Which Convex

`api/index.ts` reads the Convex URL from env, so it follows the Vercel
environment: production deployment -> prod Convex, preview/dev -> dev Convex. The
stdio client never knows which; it only knows the ingest URL.

### The discriminator is configuration, not transport — SUPERSEDED

Decision (2026-09-03): **ALP is hosted-only.** The stdio entrypoint never
registers the tools, so `npx` users cannot enable them; only a deployment that
configures its sink (`ALP_SINK_URL` + `ALP_SINK_SECRET`) serves them. The
original reasoning below is kept for history — the npx-users-are-good-signal
argument may reopen this later, and the code structure (tools gated on a
server option) makes that a one-line change in `src/stdio.ts`.

### Original reasoning (historical)

Making ALP hosted-only would be a mistake. A public user running
`npx @runpod/mcp-server` with their own key and hitting a real bug is better
signal than hosted traffic, not worse, and they are already inside the same trust
boundary — the package sends their API key, pod configs and endpoint definitions
to Runpod on every call. Feedback text is consistent with that, provided it is
disclosed and can be turned off.

So enablement follows configuration:

| Ingest URL                    | Behaviour                                                   |
| ----------------------------- | ----------------------------------------------------------- |
| default (production endpoint) | Tools active. Covers hosted and ordinary `npx` users alike. |
| pointed at localhost          | Contributor running their own stack, below.                 |
| explicitly off                | Tools absent — see below.                                   |

### Disabled means absent, not broken

When ALP is off the four tools must not appear in `tools/list` at all.

A registered tool costs context in every request, and a registered-but-failing
tool is worse than an absent one: the agent pays to read the definition, calls it,
gets an error, and may retry. Absence is unambiguous and free.

### Running the whole stack locally

This falls out of the `api/` boundary with no second code path:

```
vercel dev                  # serves api/index.ts on :3000, reads ALP_SINK_URL from env
npx convex dev              # the contributor's own dev deployment

RUNPOD_MCP_ALP_URL=http://localhost:3000/api/alp/submit
```

The ingest URL env var _is_ the local-testing mechanism. Convex credentials live only in the `vercel dev` environment — which is where the
public-repo rules already require them — so nothing secret reaches the stdio
process.

**A contributor cannot reach our Convex.** The deployment URL and shared secret
exist only as Vercel env vars, never in the repo, so there is no configuration a
local checkout can hold that would let it write directly to the production store.
That is the whole point of the `api/` boundary and the no-defaults rule.

Leaving the ingest URL at its default therefore does not "pollute production" — it
submits through the public authenticated endpoint as that person's own identity,
rate-limited, exactly like any `npx` user. Because the submission carries an
identity, internal orgs can be tagged and excluded from dashboards and clusters,
which is a real control rather than a documentation plea.

Pointing at a local stack is still the better loop while iterating, since you can
read your own rows back immediately.

## Identity

### Do not key on the API key

Key every record on the **resolved Runpod user/org ID**, never on the API key or
a hash of it. The server already resolves key -> identity during auth, so store
what that resolution returns.

Hashing the key breaks in two ways, one of them before rotation is even
involved:

- One person holds several keys, so their corpus fragments across them.
- Rotating a key orphans everything they ever saved.

A key is a credential; an ID is an identity. The corpus belongs to the identity,
which makes key rotation a non-issue by construction rather than something
needing a scheme.

### Convex functions are publicly callable — and one ingest endpoint closes it

Scoping enforced in the MCP tool handler is **not enforcement**. Convex functions
are callable directly over HTTP by anyone who knows the deployment URL. A sibling
Convex deployment in this org currently has exactly this hole: unauthenticated
POSTs to `/api/query` read data that an app-layer check was supposed to protect.

The fix falls out of the ingest topology above: **the Vercel server is the only
caller of Convex.** No client — hosted or local — ever holds a Convex URL or
credential. Given that:

- Every Convex function requires a server-side shared secret: one random string,
  held as an env var on both Vercel and Convex, compared plainly. Not user auth —
  it answers "are you my server", nothing else. That closes the
  public-callability hole outright.
- Rotating it means a few seconds where the two sides disagree and writes fail.
  Given fail-soft that costs a handful of feedback rows, so set Convex first, then
  Vercel, and accept the gap. No multi-secret scheme.
- Identity may then be passed as an argument, because only the trusted server can
  pass one.

An earlier draft of this doc had the MCP server minting short-lived signed tokens
per user so Convex could derive identity rather than accept it. That is no longer
needed — it was solving a problem that only exists if clients call Convex
directly, and none do. Recorded here because the reasoning is not obvious from
the end state: `getMyJournal(identity)` is safe _only_ because of the single-caller
property, and it becomes unsafe the moment anything else is given Convex access.

## Fields

The PRD requires four agent-supplied fields (`content`, `model_type`, `harness`,
`intention`). Two of those the server can capture itself, and asking the model
for them costs tokens to get a worse, inconsistent value.

| Field               | Source          | Notes                                                                                                                             |
| ------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `content`           | tool arg        | The feedback, learning, or question                                                                                               |
| `intention`         | tool arg        | Short: what the agent was trying to do                                                                                            |
| `model_type`        | tool arg        | Self-reported hint. Expect sparse and sometimes wrong — models misreport their own version. Do not treat as a reliable dimension. |
| `type`              | implicit        | Set by which tool was called                                                                                                      |
| `harness` + version | caller tracking | See caveat below                                                                                                                  |
| `identity`          | auth session    | Resolved user/org ID                                                                                                              |
| `transport`         | tool context    | `stdio` or `http`                                                                                                                 |

Two agent-supplied fields plus one self-report. Fewer required args means a
higher call-through rate.

### Harness capture caveat

`src/_shared/tracking.ts` already resolves calling-client identity for outbound
API headers, so this is a reuse, not new work. But the resolution quality
differs by transport, per the comment in `buildToolContext` (`src/http.ts`):

- **stdio**: real MCP `clientInfo` from the `initialize` handshake.
- **hosted HTTP**: a `tools/call` is a separate request from `initialize` in the
  stateless HTTP transport, so the per-request server never sees `clientInfo`.
  It falls back to the inbound `User-Agent`.

So harness attribution on the hosted path is coarser than on stdio. Record which
source produced it rather than pretending the two are equivalent.

### No session-scoped call logging

Considered and rejected: deriving `intention` from the tool calls that preceded
the submission in the same session. Ground truth would beat self-reported prose,
but it is a bigger privacy and storage commitment than this phase should make.

Two consequences to design around:

1. `intention` is the only join key for clustering. Grouping is embedding
   similarity over `content` + `intention` alone, which makes the vector index
   load-critical in Phase 1 rather than a Phase 2 nicety.
2. Reproducibility drops out — a row can say "create-pod failed" without the
   args that failed. Cheap partial fix that captures nothing behind the model's
   back: the server instructions ask the agent to paste the failing
   request/response into `content` itself.

## Write path

Do **not** fire-and-forget the write. On Vercel the function can be frozen the
instant the response returns, so a non-awaited Convex mutation may silently
vanish.

```
tool handler (either transport)
  args:    content, intention, model_type
  context: identity (auth), harness + version (tracking), transport
  -> await POST /api/alp/submit          (see Ingest topology)
       -> await convex.mutation(submissions.create)              returns id
            -> scheduler.runAfter(0, ingest.process)
                 scrub -> embed -> set status
       (clustering is a batch job at review time, not per submission)
Convex
  submissions  (type, content, redacted, scrubVersion, intention, model,
                harness, harnessSource, transport, identity, status, verified,
                visibility, clusterId)
  vector index on embedding; by_type_time index for the dashboard
  clusters     (label, count, firstSeen)   — populated by the batch job
  answers      — Phase 2 only; RT3 returns nothing in Phase 1
```

Await the mutation (~50ms) and push the expensive work — scrubbing, embedding —
into a scheduled action the mutation triggers. Tool responses stay fast and the
slow work becomes retryable.

Clustering does **not** belong in that per-submission action. With no live Slack
feed there is no consumer that needs a cluster the moment a row lands, so it runs
as a batch job over the corpus at review time. That keeps the ingest action to two
steps and makes re-clustering with better parameters a re-run rather than a
backfill.

All three routes share this shape. RT3's static response means it has no
request-time latency budget of its own, which is the main reason to keep skill
matching out of Phase 1 — the hosted server is reaped at 60s and tool waits
already clamp below that.

## Secret scrubbing is Phase 1, not Phase 2

The PRD defers scrubbing to Phase 2 because that is when data becomes public.
But the leak happens at **write** time. If an agent pastes a `RUNPOD_API_KEY`
into `content` today, it is in the table today regardless of when visibility gets
flipped.

Scrub in the ingest action from the first commit: store the redacted body, and
record that a redaction fired (a redaction rate is itself a useful metric).

## Rate limiting

Decision (2026-09-03, supersedes the KV design below-in-history): **no KV rate
limiter in P0.** The routes require an authenticated Runpod identity, and the
Vercel project already carries platform DDoS mitigation plus WAF rules:
unauthenticated POSTs are enforced at 60/min/IP, and authenticated traffic has
an observe rule (300/min/IP, log-only) whose enforcement is a dashboard flip.
Because WAF rules match on path, a rule scoped to `/api/alp/*` can be added
later without any code change. Per-identity quotas also stay possible later:
the ingest endpoint resolves identity on every request anyway, so a limiter
keyed on it slots in at that one point.

What P0 keeps from the original design is the posture, not the mechanism:

### It must fail soft

An ALP rate limit must never derail the agent's actual task. These tools are side
quests — the agent called `save_to_journal` while trying to deploy something. A
hard error, a thrown exception, or anything that reads as a tool failure invites
retry loops and burns the agent's turn on our bookkeeping.

So on limit: return a calm, successful tool result saying the entry was not
recorded and not to retry. Not an error, not a 429 shape. The one thing the
response must do is suppress the retry, which is exactly the lesson
`rateLimitHint` already encodes for upstream 429s — reuse the wording style, not
the code path.

## This is a public repo — what that constrains

Two distinct leak surfaces, with different rules.

1. **The published npm package.** `files` is `["dist/**/*", "CHANGELOG.md"]`, and
   tsup's entries are `src/stdio.ts`, `src/http.ts`, `src/tools.ts`. Everyone who
   installs `@runpod/mcp-server` gets all three, so **anything under `src/` is
   published — including the hosted-path modules.** `api/` is compiled separately
   by Vercel and never enters `dist`.
2. **The public GitHub source.** Every file is readable, `api/` included. That
   makes the _architecture_ visible, which is fine and not a leak. What must never
   be visible is any _value_: deployment URLs, tokens, project ids, secrets.

### Rule 0 — the Convex side lives in a private repo — SUPERSEDED

Decision (2026-09-03): the Convex side lives in THIS repo, under `convex/` —
one repo for the whole feature. It holds no values (the shared secret and
deploy keys are env-only, and `convex/` is in neither the npm `files` list nor
the Vercel build). Accepted consequence: the scrub ruleset is public, so it
stays a best-effort pattern pass rather than a secret defense.

### Original reasoning (historical)

Public contributors work on the MCP tools. The Convex side is internal-only, and
Convex deploys from its own directory independently of Vercel, so it does not need
to be in this repo at all.

| Repo              | Holds                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| this one (public) | the three P0 tool definitions in `src/`; a thin ingest handler (`src/alp/`, mounted at `/api/alp/submit`) that resolves identity, runs the courtesy scrub, and POSTs to the private sink |
| private           | `convex/` — schema, mutations, the ingest action (scrub, embed), the review-time clustering job, the dashboard                                                                           |

That makes the boundary a GitHub permission rather than a directory convention,
and it means schema iteration needs neither a public PR nor an npm release.

**Consequence: the scrubbing rules must stay private.** Publishing a
secret-detection ruleset tells anyone exactly what evades it. Scrubbing already
lives in the Convex ingest action in this design, so nothing changes — but it is
now a requirement rather than a coincidence, and it rules out ever moving
scrubbing forward into `api/` to save a hop.

What remains public is fine: rate-limit logic (quotas are not secrets, and knowing
them does not help evade a per-identity limit) and identity resolution, which is
already public in this repo today.

### Rule 1 — no private-infra values outside the deployment env

Not "no secrets in `src/`" — no infrastructure surface at all. A new `api/alp/`
module tree, imported only by `api/index.ts`. The npm bundle should contain no
evidence that the private sink exists.

This is stricter than it needs to be for secrecy alone, and worth it because it
makes the boundary structural instead of a habit: a contributor cannot
accidentally publish the ingest internals by importing them from a tool file,
because the tool files cannot see them.

The tools in `src/` only ever know one thing: the ingest endpoint URL.

### Rule 2 — defaults for public endpoints, never for private infra

The repo already draws this line correctly. `src/_shared/backend.ts` hardcodes
fallbacks for public product hosts (`rest.runpod.io/v1`, `api.runpod.io/v2`,
`api.runpod.io/graphql`), and `src/install/clients.ts` does the same for
`mcp.getrunpod.io`. Those are public endpoints; publishing them leaks nothing.

Follow it:

| Value                 | Default                                                                      | Lives in |
| --------------------- | ---------------------------------------------------------------------------- | -------- |
| ALP ingest URL        | yes — a public endpoint on a Runpod domain, same class as `mcp.getrunpod.io` | `src/`   |
| Convex deployment URL | **none**                                                                     | `api/`   |
| Convex shared secret  | **none**                                                                     | `api/`   |

The ingest URL needs a default, or stdio users get no ALP unless they configure
one, which nobody will. That is acceptable precisely because it is an
authenticated, rate-limited public endpoint — the same thing every other Runpod
API host in this table already is.

Everything in the "none" rows is `process.env.X` with no `??` fallback. A missing
value disables the feature; it never
falls back to a guessed URL.

### Rule 3 — never echo infrastructure back to the agent

The subtle one, and unique to this design. If a sink call fails and the
raw error reaches the tool result, the deployment URL travels into the agent's
context — and from there into terminal scrollback, session transcripts, bug
reports, and pasted GitHub issues. The failure path leaks what the code was
careful not to hardcode.

So the ingest endpoint returns its own flat outcome (recorded / not recorded /
temporarily unavailable) and never forwards an upstream error body or URL. Same
for logs: log the outcome and the identity, not the endpoint that failed.

`src/_shared/rate-limit.ts` is the precedent worth copying — it deliberately
declines to name windows it cannot vouch for rather than asserting a fact in a
message an agent will read.

### Rule 4 — an enforceable guard, not a convention

Docs do not survive contributors who have not read them. Add a build-time check
that greps the produced `dist/` for `convex`, `upstash`, and the ingest
internals, and fails the build on a hit. The repo already has structural tests
(`tests/spec-parity.test.ts`) so this fits existing practice.

Also in scope for the same check, because these are where values actually slip in:

- `tests/fixtures/` — a real deployment URL pasted into a fixture is the most
  common version of this mistake.
- `.env.example` — ship one, with names and empty values only. `.gitignore`
  already covers `.env*` with an `!.env.example` exception, so the file is
  expected and currently missing.

## Forward compatibility: public entries and a global forum

Phase 1 keeps every journal entry private to its identity. The likely Phase 2+
direction is per-entry public/private with a global search forum across the
public set, so the decisions below are made now, while they are free.

**Publishing is a one-way door.** `visibility` is mutable in the schema, but
flipping public back to private recalls nothing — the entry may already be in
another agent's context or copied into another journal. Default private; treat
publishing as irreversible in the tool surface and the UX, not as a toggle.

**Re-scrub at publish, not only at write.** Scrubbing rules improve over time, so
an entry written in month one and published in month six was scrubbed by
month-one rules. Store a `scrubVersion` on every entry and re-run the current
ruleset at publish. Retrofitting this is impossible once there is a backlog of
entries whose scrub provenance is unknown.

**The public projection must not carry identity.** "Org X hit a bug deploying
model Y" is competitive intel about org X. Identity therefore has to be
separable from the entry at publish time, which means never denormalizing
identity into any field a public view reads.

**Publish copies into a separate collection — it does not flip a boolean on the
shared table.** This is the structural one. If global search filters a single
table by `visibility == "public"`, every public query touches private rows and one
missing predicate leaks the corpus. A physically separate public collection has no
access to private data to leak. Same reasoning as not letting Convex accept
`identity` as an argument: make the safe property structural rather than
conditional.

### Encryption was considered and rejected

Asked and answered: encrypted RAG search is technically possible (TEEs, or
homomorphic schemes) and not worth it here. Two reasons, the second decisive:

- Encrypting `content` while leaving embeddings in the clear is the tempting
  version and it does not work — embedding inversion recovers a large fraction of
  the original text from vectors alone, so a pasted secret stays extractable.
- A shared, semantically searchable corpus and content the operator cannot read
  are opposed requirements. Phase 2 wants the former.

The realistic leak is an agent pasting a credential into `content`, and the
control for that is not collecting it — hence scrubbing at write, above.
Encrypting a secret we should not hold just means holding it carefully.

## Content quality is a Phase 2 problem

Worth recording because it looks like a Phase 1 gap and is not. Per-identity
quotas (edge or otherwise) bound _volume_, not _value_: an identity can submit its full allowance of
low-value content every window, indefinitely, entirely within policy.

The likely source is not abuse. Adoption is forced by the server instructions, so
well-behaved agents will dutifully submit things like "the pod took a while to
start." No rate limit addresses that, because the volume is compliant.

Phase 1 contains it structurally rather than filtering it:

- **RT1** — the PRD accepts this outright ("fine if most of it is noise; the 20%
  gold is free"). Feedback drains to human triage, and clustering ranks by
  frequency, so noise is triage cost rather than corruption.
- **RT2** — the journal is private to the submitting identity, so an identity that
  fills it with garbage pollutes only its own journal. Nobody else reads it.
- **RT3** — questions are recorded, not served back to anyone.

Nothing cross-contaminates while the journal stays private. This becomes real the
moment Phase 2 makes entries visible across identities, and the hooks are already
in the schema: `verified` defaulting to unverified, and the
two-independent-submissions agreement rule for promotion.

## Open questions

- ~~Exact wording of the RT3 response~~ — resolved: it lives in both the tool
  description and the tool result (`src/specgen/tools/alp.ts`), and the server
  instructions repeat that `ask_question` never answers.
- Actual quota numbers per route (now a WAF threshold question), and the looser
  read budget for `read_journal` when P2 lands. See "Content quality is a Phase 2 problem" for
  why these bound volume and not value.
