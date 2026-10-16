import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { isOncePerAccountRoute } from '../src/alp/sink';
import type { Infer } from 'convex/values';
import type { routeValidator } from './schema';

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
    const body = await readObjectBody(request);
    if (!body) {
      return new Response(JSON.stringify({ error: 'expected a JSON object' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const created = await ctx.runMutation(internal.submissions.create, {
      route: body.route as Infer<typeof routeValidator>,
      content: String(body.content ?? ''),
      intention:
        typeof body.intention === 'string' ? body.intention : undefined,
      modelType:
        typeof body.modelType === 'string' ? body.modelType : undefined,
      // Triage dimensions. Named explicitly like every other field, which is
      // also what makes the deploy order forgiving: a sink that predates them
      // drops them instead of rejecting the write, so submissions keep landing
      // (without the new columns) until this is redeployed.
      severity: typeof body.severity === 'string' ? body.severity : undefined,
      tool: typeof body.tool === 'string' ? body.tool : undefined,
      workaround:
        typeof body.workaround === 'string' ? body.workaround : undefined,
      trigger: typeof body.trigger === 'string' ? body.trigger : undefined,
      source: typeof body.source === 'string' ? body.source : undefined,
      noContext:
        typeof body.noContext === 'boolean' ? body.noContext : undefined,
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
    // `duplicate` is the once-per-account verdict (submissions.create): the
    // row id is the existing row's, and the ingest handler reports
    // already_submitted instead of a write.
    return new Response(
      JSON.stringify({
        ok: true,
        id: created.id,
        duplicate: created.duplicate,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }),
});

// The once-per-account lookup. Same secret, same single-caller property. It
// answers one bit — does this identity have a row on this route — and only
// for the routes that take one answer per account, so it cannot be turned
// into a probe of what an account has submitted elsewhere.
http.route({
  path: '/alp/answered',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.ALP_SINK_SECRET;
    if (!secret || request.headers.get('x-alp-secret') !== secret) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = await readObjectBody(request);
    if (!body) {
      return new Response(JSON.stringify({ error: 'expected a JSON object' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const identity = typeof body.identity === 'string' ? body.identity : '';
    const route = body.route;
    if (!identity || !isOncePerAccountRoute(route)) {
      return new Response(
        JSON.stringify({
          error: 'identity and a once-per-account route are required',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    const answered = await ctx.runQuery(internal.submissions.hasAnswered, {
      identity,
      route,
    });
    return new Response(JSON.stringify({ ok: true, answered }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
});

// The read door for the private journal. Same secret, same single-caller
// property: the server has already resolved `identity` from the caller's own
// token, and this action forwards it unchanged. Nothing here can widen the
// filter — there is no "all" mode and no cross-identity argument.
http.route({
  path: '/alp/journal',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.ALP_SINK_SECRET;
    if (!secret || request.headers.get('x-alp-secret') !== secret) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = await readObjectBody(request);
    if (!body) {
      return new Response(JSON.stringify({ error: 'expected a JSON object' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const identity = typeof body.identity === 'string' ? body.identity : '';
    if (!identity) {
      return new Response(JSON.stringify({ error: 'identity required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const entries = await ctx.runQuery(
      internal.submissions.listJournalByIdentity,
      {
        identity,
        limit: Number(body.limit ?? 20),
      }
    );
    return new Response(JSON.stringify({ ok: true, entries }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
});

// 404 counter for the hosted server's loop breaker. Same secret, same
// single-caller property; `key` is already a salted hash of the account.
http.route({
  path: '/ratelimit/not-found',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.ALP_SINK_SECRET;
    if (!secret || request.headers.get('x-alp-secret') !== secret) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = await readObjectBody(request);
    if (!body) {
      return new Response(JSON.stringify({ error: 'expected a JSON object' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const key = typeof body.key === 'string' ? body.key.slice(0, 200) : '';
    if (!key) {
      return new Response(JSON.stringify({ error: 'key required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const { blockedUntil, started } = await ctx.runMutation(
      internal.rateLimit.recordNotFound,
      { key }
    );
    return new Response(JSON.stringify({ ok: true, blockedUntil, started }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
});

export default http;

async function readObjectBody(
  request: Request
): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}
