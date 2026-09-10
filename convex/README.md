# ALP storage sink (Convex)

The storage side of the Agent Learning Protocol (`docs/agent-learning-protocol.md`):
schema, the secret-gated ingest HTTP action, and the write mutation. Deployed to
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
reapplies it before insertion. Deploy both Convex environments when that shared
module or the mutation changes; a Vercel deploy alone does not update the sink.
