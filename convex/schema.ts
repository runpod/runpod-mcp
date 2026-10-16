import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// The one Convex-side list of routes; the write mutation reuses it. Mirrors
// ALP_ROUTES in src/alp/ingest.ts, which Convex cannot import (it pulls in
// src/http.ts) and which could not produce v.literal validators anyway.
export const routeValidator = v.union(
  v.literal('feedback'),
  v.literal('journal'),
  v.literal('question'),
  v.literal('referral')
);

// One table, one drain per route (design doc: docs/agent-learning-protocol.md in
// runpod-mcp). Fields the later phases need are reserved now so P1-P3 are
// not a migration: status/verified/visibility default to the most private
// state, embedding backfills in P1.
export default defineSchema({
  submissions: defineTable({
    route: routeValidator,
    content: v.string(),
    intention: v.optional(v.string()),
    modelType: v.optional(v.string()),
    // Triage dimensions. severity is constrained at ingest, not here, so an
    // older server that has not been redeployed cannot fail a write on it.
    severity: v.optional(v.string()),
    tool: v.optional(v.string()),
    workaround: v.optional(v.string()),
    trigger: v.optional(v.string()),
    // Referral route (CON-1762): why Runpod came up, and whether the agent
    // had any context at all. Optional here so every older row validates.
    source: v.optional(v.string()),
    noContext: v.optional(v.boolean()),
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
    // read_journal: one identity, one route, newest first, no scan past
    // that identity's feedback/question rows.
    .index('by_identity_route', ['identity', 'route'])
    .index('by_route', ['route'])
    .index('by_severity', ['severity'])
    .index('by_tool', ['tool']),
  // Hosted-server 404 counters (src/specgen/not-found-limiter.ts). One row per
  // hashed account + tool: a fixed window of 404s and, once the threshold is
  // crossed, the time the server stops serving that pair.
  notFoundCounters: defineTable({
    key: v.string(),
    windowStart: v.number(),
    count: v.number(),
    blockedUntil: v.number(),
  }).index('by_key', ['key']),
});
