import { scrubSubmission } from '../src/alp/scrub';
import { internalMutation, internalQuery } from './_generated/server';

export const MAX_JOURNAL_READ = 50;
import { v } from 'convex/values';

export const create = internalMutation({
  args: {
    route: v.union(
      v.literal('feedback'),
      v.literal('journal'),
      v.literal('question')
    ),
    content: v.string(),
    intention: v.optional(v.string()),
    modelType: v.optional(v.string()),
    severity: v.optional(v.string()),
    tool: v.optional(v.string()),
    workaround: v.optional(v.string()),
    trigger: v.optional(v.string()),
    identity: v.string(),
    harness: v.optional(v.string()),
    harnessSource: v.optional(v.string()),
    transport: v.optional(v.string()),
    redactions: v.number(),
    scrubVersion: v.number(),
    receivedAt: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('submissions', {
      ...scrubSubmission(args),
      status: 'stored',
      verified: false,
      visibility: 'private',
    });
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
      .withIndex('by_identity', (q) => q.eq('identity', identity))
      .order('desc')
      .filter((q) => q.eq(q.field('route'), 'journal'))
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
