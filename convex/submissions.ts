import { scrubSubmission } from '../src/alp/scrub';
import { isOncePerAccountRoute } from '../src/alp/sink';
import { routeValidator } from './schema';
import { internalMutation, internalQuery } from './_generated/server';

export const MAX_JOURNAL_READ = 50;
import { v } from 'convex/values';

// Validator twin of ONCE_PER_ACCOUNT_ROUTES (src/alp/sink.ts), which is what
// the dedupe below and /alp/answered branch on. Convex validators are built by
// hand, so a new once-per-account route is a literal in both places.
const oncePerAccountRoute = v.literal('referral');

export const create = internalMutation({
  args: {
    route: routeValidator,
    content: v.string(),
    intention: v.optional(v.string()),
    modelType: v.optional(v.string()),
    severity: v.optional(v.string()),
    tool: v.optional(v.string()),
    workaround: v.optional(v.string()),
    trigger: v.optional(v.string()),
    source: v.optional(v.string()),
    noContext: v.optional(v.boolean()),
    identity: v.string(),
    harness: v.optional(v.string()),
    harnessSource: v.optional(v.string()),
    transport: v.optional(v.string()),
    redactions: v.number(),
    scrubVersion: v.number(),
    receivedAt: v.string(),
  },
  handler: async (ctx, args) => {
    // Once per account: keep the FIRST answer an identity gives on the
    // referral route and decline the rest. Decided inside the mutation, the
    // only place with a transaction, so two sessions landing at once cannot
    // both store. The reply names the existing row and says it was a
    // duplicate, so the server can tell the agent that instead of reporting
    // a write that did not happen.
    const route = args.route;
    if (isOncePerAccountRoute(route) && args.identity) {
      const existing = await ctx.db
        .query('submissions')
        .withIndex('by_identity_route', (q) =>
          q.eq('identity', args.identity).eq('route', route)
        )
        .first();
      if (existing) return { id: existing._id, duplicate: true };
    }
    const id = await ctx.db.insert('submissions', {
      ...scrubSubmission(args),
      status: 'stored',
      verified: false,
      visibility: 'private',
    });
    return { id, duplicate: false };
  },
});

// Has this identity already given its one answer on a once-per-account route?
// Asked by the hosted handshake (src/alp/answered.ts) so the referral prompt
// is delivered to an account once. Internal and secret-gated like the journal
// read; `identity` is trusted only because the server is the single caller.
// One bit comes back, and only for these routes, so it cannot become a probe
// of what an account has submitted elsewhere.
export const hasAnswered = internalQuery({
  args: {
    identity: v.string(),
    route: oncePerAccountRoute,
  },
  handler: async (ctx, { identity, route }) => {
    if (!identity) return false;
    const row = await ctx.db
      .query('submissions')
      .withIndex('by_identity_route', (q) =>
        q.eq('identity', identity).eq('route', route)
      )
      .first();
    return row !== null;
  },
});

// Read-back for the private journal (design doc, "The tool pair"). Internal,
// so the only way in is the HTTP action behind the shared secret; a public
// query here would turn the deployment URL into a read of every account.
// `identity` is whatever the server resolved from the caller's Bearer token —
// this function has no way to check it, so the trust boundary is upstream.
// Only the journal route is served: feedback and questions are for Runpod's
// review, not the account's memory. Only the fields an agent can act on come
// back; attribution and moderation state stay server-side.
export const listJournalByIdentity = internalQuery({
  args: {
    identity: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, { identity, limit }) => {
    if (!identity) return [];
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_identity_route', (q) =>
        q.eq('identity', identity).eq('route', 'journal')
      )
      .order('desc')
      .take(
        Number.isFinite(limit)
          ? Math.min(Math.max(Math.trunc(limit), 1), MAX_JOURNAL_READ)
          : 20
      );
    return rows.map((r) => ({
      content: r.content,
      intention: r.intention,
      trigger: r.trigger,
      tool: r.tool,
      receivedAt: r.receivedAt,
    }));
  },
});
