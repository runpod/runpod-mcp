# ALP storage sink (Convex)

The storage side of the Agent Learning Protocol (`docs/agent-learning-protocol.md`):
schema, the secret-gated HTTP actions (submit, journal read, once-per-account
lookup), and the write mutation. Deployed to
the Convex project linked to the Vercel `runpod-mcp` project — NOT part of the
npm package or the Vercel build.

No secrets live here. The shared server secret is `ALP_SINK_SECRET`, set as an
env var on both the Convex deployment (`npx convex env set`) and Vercel; the
ingest action rejects any request that does not present it, which makes the
Vercel server the only caller.

## One sink per environment

Production and Preview write to **different Convex deployments**, each with its
own `ALP_SINK_SECRET`, so preview traffic never reaches the production table and
clearing one store cannot touch the other. Each secret is rejected by the other
deployment (verified). The Vercel `Development` target is deliberately left
unconfigured: ALP is hosted-only, and absent from `tools/list` is the disabled
state.

Deploy `convex/` to both when the schema or the ingest action changes — the
preview deployment is not updated by a production deploy.

The deployment names are deliberately not written down here (Rule 1: no
infrastructure values in a public repo). `ALP_SINK_URL` is a readable Vercel env
var per environment, so read the name from there — then inspect what that sink
stored:

```bash
npx convex data submissions --deployment <name>
```

Deploy (per environment, using that environment's deploy key):

```bash
CONVEX_DEPLOY_KEY=<key> npx convex deploy -y
CONVEX_DEPLOY_KEY=<key> npx convex env set ALP_SINK_SECRET <same value as Vercel>
```

The write mutation imports the shared redactor from `src/alp/scrub.ts` and
reapplies it before insertion. A production Vercel build deploys the production sink first
(`npx convex deploy` in `vercel.json`, using the integration's
`CONVEX_DEPLOY_KEY`), so a failed Convex push fails the Vercel deploy instead
of shipping a server ahead of its sink. The development sink is not built by
Vercel: deploy it by hand when the shared module or a mutation changes.

The same deployment also holds the hosted server's 404 counters
(`notFoundCounters`, `convex/rateLimit.ts`, route `/ratelimit/not-found`). The
server fails open until that route is deployed, so deploy order does not matter.

## Deploy order for a new route or field

Convex first, then Vercel. In production the build does this itself (see
above); for the development sink, run `npx convex deploy` by hand before
pointing a build at it. The `create` mutation's `route` argument validator
rejects a route it does not know, so a server that sends `referral` before
the sink accepts it makes every such submission fail soft
(`recorded: false`) until the sink catches up. The reverse order is harmless: a
sink that knows a field the server does not send yet stores rows without it.
The `/alp/answered` lookup behaves the same way, since a missing route answers
404 and the handshake treats that as unknown and keeps the prompt.

The schema change is additive and must stay. Once any `referral` row exists, a
rollback of `convex/` must keep `schema.ts` at this version or later and revert
only `http.ts` and `submissions.ts`: Convex validates existing documents
against the pushed schema, and the older `route` union would refuse the push.
