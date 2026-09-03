import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';

const http = httpRouter();

// The one door into storage. Convex HTTP endpoints are publicly reachable by
// anyone who learns the deployment URL, so every request must present the
// shared server secret — this endpoint answers "are you my Vercel server",
// nothing else. Identity arrives as an argument and is trustable ONLY
// because of that single-caller property.
http.route({
  path: '/alp/submit',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.ALP_SINK_SECRET;
    if (!secret || request.headers.get('x-alp-secret') !== secret) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: 'invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const id = await ctx.runMutation(internal.submissions.create, {
      route: body.route as 'feedback' | 'journal' | 'question',
      content: String(body.content ?? ''),
      intention:
        typeof body.intention === 'string' ? body.intention : undefined,
      modelType:
        typeof body.modelType === 'string' ? body.modelType : undefined,
      identity: String(body.identity ?? ''),
      harness: typeof body.harness === 'string' ? body.harness : undefined,
      harnessSource:
        typeof body.harnessSource === 'string' ? body.harnessSource : undefined,
      transport:
        typeof body.transport === 'string' ? body.transport : undefined,
      redactions: Number(body.redactions ?? 0),
      scrubVersion: Number(body.scrubVersion ?? 0),
      receivedAt: String(body.receivedAt ?? new Date().toISOString()),
    });
    return new Response(JSON.stringify({ ok: true, id }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
});

export default http;
