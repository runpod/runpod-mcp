import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// One table, three drains (design doc: docs/agent-learning-protocol.md in
// runpod-mcp). Fields the later phases need are reserved now so P1-P3 are
// not a migration: status/verified/visibility default to the most private
// state, embedding backfills in P1.
export default defineSchema({
  submissions: defineTable({
    route: v.union(
      v.literal('feedback'),
      v.literal('journal'),
      v.literal('question')
    ),
    content: v.string(),
    intention: v.optional(v.string()),
    modelType: v.optional(v.string()),
    // The resolved Runpod identity — never an API key or a hash of one.
    identity: v.string(),
    harness: v.optional(v.string()),
    harnessSource: v.optional(v.string()),
    transport: v.optional(v.string()),
    redactions: v.number(),
    scrubVersion: v.number(),
    receivedAt: v.string(),
    // Reserved for P1-P3.
    status: v.string(), // 'stored' -> 'processed'
    verified: v.boolean(), // RT2 promotion state
    visibility: v.string(), // 'private'; P3 publishing copies, never flips
  })
    .index('by_identity', ['identity'])
    .index('by_route', ['route']),
});
