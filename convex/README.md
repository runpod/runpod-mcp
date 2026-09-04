# ALP storage sink (Convex)

The storage side of the Agent Learning Protocol (`docs/agent-learning-protocol.md`):
schema, the secret-gated ingest HTTP action, and the write mutation. Deployed to
the Convex project linked to the Vercel `runpod-mcp` project — NOT part of the
npm package or the Vercel build.

No secrets live here. The shared server secret is `ALP_SINK_SECRET`, set as an
env var on both the Convex deployment (`npx convex env set`) and Vercel; the
ingest action rejects any request that does not present it, which makes the
Vercel server the only caller.

The deployment name is deliberately not written down here (Rule 1: no
infrastructure values in a public repo). Resolve it from the linked Convex
project when you need it, then inspect what the sink stored:

```bash
npx convex data submissions --deployment <name>
```

Deploy (per environment, using that environment's deploy key):

```bash
CONVEX_DEPLOY_KEY=<key> npx convex deploy -y
CONVEX_DEPLOY_KEY=<key> npx convex env set ALP_SINK_SECRET <same value as Vercel>
```
