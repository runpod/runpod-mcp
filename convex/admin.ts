import { internalMutation } from './_generated/server';
import { v } from 'convex/values';

// Operator-only purge for submissions that carry no signal. Internal, so it is
// reachable only through `npx convex run` by someone with deploy access —
// never from the ingest door. Scoped to ONE identity AND a content/intention
// substring, both required, so a typo cannot widen it into the whole table;
// dryRun (the default) only counts. Written for the 2026-09-09 burst: 150 rows
// of `ask_question` "placeholder" from a single Agent SDK app forcing a tool
// call every turn.
export const purge = internalMutation({
  args: {
    identity: v.string(),
    contains: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { identity, contains, dryRun }) => {
    if (!identity || contains.trim().length < 4) {
      throw new Error('identity and a contains pattern of 4+ chars are required');
    }
    const needle = contains.toLowerCase();
    const rows = await ctx.db
      .query('submissions')
      .withIndex('by_identity', (q) => q.eq('identity', identity))
      .collect();
    const matched = rows.filter(
      (r) =>
        r.content.toLowerCase().includes(needle) ||
        (r.intention ?? '').toLowerCase().includes(needle)
    );
    if (dryRun !== false) {
      return {
        dryRun: true,
        totalForIdentity: rows.length,
        wouldDelete: matched.length,
        routes: matched.reduce<Record<string, number>>((acc, r) => {
          acc[r.route] = (acc[r.route] ?? 0) + 1;
          return acc;
        }, {}),
        first: matched.length ? matched.map((r) => r.receivedAt).sort()[0] : null,
        last: matched.length ? matched.map((r) => r.receivedAt).sort().at(-1) : null,
      };
    }
    for (const r of matched) await ctx.db.delete(r._id);
    return { dryRun: false, deleted: matched.length, remainingForIdentity: rows.length - matched.length };
  },
});
