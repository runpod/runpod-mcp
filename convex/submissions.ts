import { internalMutation } from './_generated/server';
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
      ...args,
      status: 'stored',
      verified: false,
      visibility: 'private',
    });
  },
});
