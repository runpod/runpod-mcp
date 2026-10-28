> Current redaction implementation: `src/alp/scrub.ts` is shared by the
> Vercel ingest handler and the Convex write mutation. Both apply the same
> best-effort pass to all user-authored text, including metadata, before storage.
> It catches known credential formats and sensitive JSON/YAML/env assignments, Hugging Face tokens, and URL query secrets.
> There is no separate private or authoritative scrubber; historical references
> to one below are superseded. Unlabeled arbitrary secrets may still evade
> detection, so agents must continue to omit credentials from submissions.

# Agent Learning Protocol — Phase 1 architecture

Working design doc for the agent-feedback tool calls (three at P0, a fourth
write route added for CON-1762) described in the
[Agent Feedback via Runpod MCP PRD](https://app.notion.com/p/3b4ff732fc3480e89ed5fda203a73841).
Status: P0 implemented on `feat/specgen-server` (tools `src/specgen/tools/alp.ts`, ingest `src/alp/`). Decisions here supersede the PRD where noted; the KV rate-limiter sections were superseded on 2026-09-03 — see Rate limiting.

## Phasing lives in Linear

[CON-1407](https://linear.app/runpod/issue/CON-1407/implement-stack-overflow-for-agents-on-runpod-mcp)
is the single source of phasing (P0-P3) and of which sub-ticket covers what. This
document is the design reasoning behind those decisions; it deliberately does not
restate the phase breakdown, so the two cannot drift.

Project: `[ROCK] CON_2026 Q3: Stack Overflow for Agents (ALP)`, Console Experience.

## Scope

Phase 1 of the PRD: three push tool calls at P0 in this MCP server, a store behind
them, and an internal path to read the data. Convex is the store (a Convex
deployment is already linked to the Vercel project hosting this server).

Phase 2 (agent-facing pull, consent model) and Phase 3 (published standard) are
out of scope, but the schema below reserves the fields those phases need so they
are not a migration.

## The routes

The PRD specifies "same handler and same table underneath". That is right for
storage and wrong for behavior: the tools converge on one write path and
diverge completely on what happens downstream. Treat them as one table with
one drain per route.

| Route | Tool                               | Drains to                                        | Duplicates are                  |
| ----- | ---------------------------------- | ------------------------------------------------ | ------------------------------- |
| RT1   | `report_feedback`                  | Internal review — dashboard, then Linear         | Signal — frequency is priority  |
| RT2   | `save_to_journal` / `read_journal` | The corpus, private per-identity first           | Confirmation — promotion signal |
| RT3   | `ask_question`                     | The void — recorded only, offline docs-gap queue | Coverage gap evidence           |
| RT4   | `report_how_user_found_runpod`     | Demand generation readout — AEO content themes   | Declined: one per account       |

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

  Shipped 2026-09-09. The tool takes a `limit` and nothing else: identity is
  never an argument, on the tool or on the server route. The hosted handler
  resolves the account from the Bearer token exactly as ingest does and sends
  that id as the only filter to a second secret-gated sink action
  (`/alp/journal`, an `internalQuery` behind an `httpAction`). Any failure
  returns zero entries with a no-retry note; it never falls back to a wider
  query. Only the journal route is served — feedback and questions stay
  write-only.

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
  symmetric with the other write routes: fire the write, return a constant. This is
  the main reason skill matching stays out of Phase 1 — the hosted server is
  reaped at 60s and tool waits already clamp below that.
- **Coverage-gap detection is offline.** There is no per-request "did a skill
  match" column, so it is a review over accumulated questions. Clustering, which
  RT1 needs anyway, is what makes that review tractable.

Still worth recording per question: whether the same identity asked again
afterward, which is the cheapest proxy for "the void was not good enough."

### RT4 — `report_how_user_found_runpod`

The referral ask ([CON-1762](https://linear.app/runpod/issue/CON-1762)), added
2026-10 for the demand generation team. AEO (answer-engine optimization: content
written so AI assistants cite it) needs to know what people asked an AI before
it pointed them to Runpod, and no AEO tool exposes that; when an agent
found Runpod in the same session, the agent has exactly that context. So the
server asks the agent, once per account: what kind of work brought the user
to Runpod, and why Runpod came up.

This is the one route that concerns the **user's request** rather than
Runpod's behavior, and the user never sees the question, so it collects
categories, never the user's words. The tool text tells the agent not to
quote or paraphrase the request and not to include names, models, data, or
project details. `content` is an optional short generic note in the agent's
own words, capped at 200 characters (`MAX_REFERRAL_CONTENT_CHARS`), and goes
through the same scrub as every other submission. The trade-off is that the
readout shows what kinds of work bring people to Runpod, not the exact
phrasing they used. Expect most answers to be "no context":
agent sessions usually start after the user signed up on the web. Those are
recorded too, as `noContext: true`, because the share of answers with real
context is the readout's first number.

Fields beyond the shared ones: `useCase` (the kind of work: `inference`,
`fine_tuning`, `training`, `image_video_generation`, `dev_environment`,
`batch_processing`, `other`), `source` (why Runpod came up: `searched`,
`user_named`, `recommended`, `other`), and `noContext` (always a boolean on
this route, absent on the others). Off-enum `useCase` and `source` values are
dropped like `severity`. A valid `useCase` or `noContext: true` is a complete
answer without `content`. `intention` is not asked — it is a feedback/journal
field.

#### Once per account, in two places

"Ask once per user, not every session" is enforced where each half can be:

- **Storage keeps the first answer.** `submissions.create` checks
  `by_identity_route` for the referral route inside the mutation (the only
  place with a transaction) and declines a second write, returning the
  existing row with `duplicate: true`. The ingest handler turns that into
  `{ recorded: false, reason: 'already_submitted' }`, and the tool says so in
  its own words: not the transient "not recorded, do not retry" wording, which
  a later session would read as permission to try again. A `noContext` answer
  closes the slot like any other — that is the literal rule, and it is what
  gives the readout its denominator. The alternative (let a later session
  with real context replace a no-context answer) was considered and left out:
  it would make the prompt permanent for most accounts.
- **The handshake stops asking.** The prompt lives in the `initialize`
  instructions, so on `initialize` — and only when the credential pre-flight
  resolved an account id — `src/http.ts` asks the sink whether the account
  has answered (`src/alp/answered.ts` → `POST /alp/answered`, secret-gated,
  one bit back, only for once-per-account routes) and omits the paragraph
  when it has. Fail-soft toward asking: an unreachable or unrecognized sink
  keeps the prompt, and the write-time dedupe is the backstop, so a wrong
  guess costs one `already_submitted` tool call and never a duplicate row.
  The lookup needs an account id, so under `MCP_SKIP_CREDENTIAL_CHECK`, the
  environment-mismatch self-disable, or a failed-open pre-flight the prompt is
  simply kept. The cost is one uncached sink round trip (2.5 s cap) per such
  `initialize`. `tools/list` is a separate request and is not gated, so the
  tool stays advertised; its description carries the once-only rule for a
  direct call.

#### Coordinating with the agent NPS ask

[CON-1729](https://linear.app/runpod/issue/CON-1729) adds an NPS score tool
that fires from the success response of an account's third resource creation
and is also once per account, enforced in Convex on the same identity. It
should reuse this machinery rather than add a second copy. The registry is
`ONCE_PER_ACCOUNT_ROUTES` in `src/alp/sink.ts`: the Convex dedupe
(`submissions.create`) and the `/alp/answered` route branch on it. The hosted
handshake does not; it passes the literal `'referral'` to `hasAnswered`. A new
once-per-account route is a literal in that list, in the `oncePerAccountRoute`
Convex validator (in the hosted service repository), in `ALP_ROUTES`
(`src/alp/ingest.ts`) and the schema's `route` union, plus the tool itself and
a `hasAnswered(accountId, '<route>')` call wherever its ask is delivered.
The hosted service's `alp-sink-http` test fails if the Convex validators and
the server lists drift apart.

To keep a single session from being asked both: the referral ask fires at
session start, before any creation, and the NPS note fires on the third
creation. Since the hosted transport is stateless there is no session to key
on, so the cheap rule is time: when the NPS note would fire, skip it if the
account's referral row has a `receivedAt` within the last few minutes. The
note repeats on every later creation until answered, so skipping once costs
nothing. The referral side needs no matching rule, because it cannot fire
after an NPS ask in the same session.

## Ingest topology

ALP is hosted-only. The public npm package contains no storage credentials, and
local stdio does not register ALP tools.

```text
Hosted MCP tool
  -> POST /api/alp/submit (caller's Runpod API key)
  -> resolve account identity
  -> scrub submitted text
  -> Convex HTTP action (server-side shared secret)
  -> scrub again with the same rules and store
```

The read handler at `/api/alp/journal` resolves the caller's identity before
querying the account-scoped journal. Neither handler accepts a caller-selected
storage host. The Convex deployment also serves `/alp/answered`, the
once-per-account lookup: the hosted handshake calls it (`src/alp/answered.ts`)
to decide whether to deliver the referral ask. It is server-internal, not an
HTTP route of this server. Embedding, clustering and public search are future
work.

## Enablement and local testing

The hosted tools appear only when `ALP_SINK_URL` and `ALP_SINK_SECRET` are set.
Configure these for the intended production, preview or development sink; the
application does not select a Convex deployment automatically.

### Disabled means absent, not broken

When ALP is off none of the ALP tools may appear in `tools/list` at all.

A registered tool costs context in every request, and a registered-but-failing
tool is worse than an absent one: the agent pays to read the definition, calls it,
gets an error, and may retry. Absence is unambiguous and free.

### Running the whole stack locally

The Vercel entry point and the Convex functions live in the hosted service's
own repository; run `vercel dev` and `npx convex dev` there. The handlers live
in `src/alp/` here and reach that service through `@runpod/mcp-server/hosted`.

Connect an MCP client to the local HTTP server. ALP tools appear only when that
server has `ALP_SINK_URL` and `ALP_SINK_SECRET` configured for your own development
Convex deployment. The HTTP handler derives its ingest URL from the current
request; there is no stdio ALP URL override or default production ingest URL.

Use the development sink when testing writes. The application does not enforce
ALP rate limits; optional deployment WAF rules are described under Rate limiting.

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
| `source`            | tool arg        | RT4 only: why Runpod came up (`searched`, `user_named`, `recommended`, `other`). Off-enum values are dropped.                     |
| `noContext`         | tool arg        | RT4 only: the agent had no context on how the user found Runpod. Always a boolean on that route, absent elsewhere.                |
| `useCase`           | tool arg        | RT4 only: the kind of work that brought the user to Runpod. Enum; off-enum values are dropped.                                    |

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

All routes share this shape. RT3's static response means it has no
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
   published — including the hosted-path modules.** The Vercel entry point lives
   in the hosted service's repository and never enters `dist`.
2. **The public GitHub source.** Every file is readable. That
   makes the _architecture_ visible, which is fine and not a leak. What must never
   be visible is any _value_: deployment URLs, tokens, project ids, secrets.

### Rule 0 — the Convex side lives in the hosted service repository

Decision (2026-10-28): the Convex functions and the Vercel entry point live in
the hosted service's own repository, which consumes `@runpod/mcp-server/hosted`
and `@runpod/mcp-server/alp`. Between 2026-09-03 and 2026-10-28 they lived in
this repo under `convex/` and `api/`, holding no values (the shared secret and
deploy keys were env-only). The scrub ruleset stays public because
`src/alp/scrub.ts` ships in the package, so it remains a best-effort pattern
pass rather than a secret defense.

### Original reasoning (historical)

Public contributors work on the MCP tools. The Convex side is internal-only, and
Convex deploys from its own directory independently of Vercel, so it does not need
to be in this repo at all.

| Repo              | Holds                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| this one (public) | the five tool definitions in `src/`; a thin ingest handler (`src/alp/ingest.ts`, mounted at `/api/alp/submit`) that resolves identity, runs the courtesy scrub, and POSTs to the private sink; a thin read handler (`src/alp/read.ts`, mounted at `/api/alp/journal`) that resolves identity the same way and forwards only that id as the filter |
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

### Rule 1 — storage credentials stay in the deployment environment

`src/alp/ingest.ts` and `src/alp/read.ts` implement the HTTP handlers the hosted
service mounts. They read the storage URL and shared secret from the server's
environment. The tool clients know only the authenticated HTTP endpoint URL;
they never receive storage credentials. The scrubber and Convex schema are public
source in this repository.

### Rule 2 — no defaults for storage credentials

| Value | Source |
| --- | --- |
| ALP ingest URL | Derived from the current hosted request by `src/http.ts` |
| Convex deployment URL | `ALP_SINK_URL`, no fallback |
| Convex shared secret | `ALP_SINK_SECRET`, no fallback |

Missing sink configuration disables the hosted tools. Local stdio never registers
them. Authentication is implemented by the application; rate limiting depends on
optional deployment WAF configuration and must not be assumed to be active.

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
