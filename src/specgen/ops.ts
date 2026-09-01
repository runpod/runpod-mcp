// Operational seam for the hosted path: per-tool-call structured logging and
// the rate-limit gate. The rate limiter is a deliberate STUB — it defines the
// seat in the request path (keyed on a caller identity, consulted before any
// tool work) so real enforcement (e.g. a KV-backed counter) can land without
// touching the dispatch pipeline. Until then it always admits.
//
// SECURITY: nothing in this file may log the API key, the Authorization
// header, or tool arguments (which can carry payload secrets). Callers are
// identified by a short salted hash of the token — stable within one warm
// instance for correlation, useless for recovering the credential.

import { createHash, randomBytes } from 'node:crypto';

// Per-process salt: caller ids correlate within an instance's log window but
// cannot be joined across instances or replayed offline against a key list.
const SALT = randomBytes(16).toString('hex');

export function callerId(token: string | undefined): string {
  if (!token) return 'anonymous';
  return createHash('sha256')
    .update(SALT)
    .update(token)
    .digest('hex')
    .slice(0, 12);
}

// ---- rate limiting (stub) ----

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds the caller should wait; only set when denied. */
  retryAfterS?: number;
}

export type RateLimiter = (
  caller: string,
  toolName: string
) => Promise<RateLimitVerdict>;

// Always admits. Replace with a KV/Upstash-backed counter to enforce; the
// http handler already turns a denial into a JSON-RPC tool error with a
// retry hint, so enforcement is a one-function change.
export const noopRateLimiter: RateLimiter = async () => ({ allowed: true });

// ---- structured tool-call logging ----

export interface ToolCallLog {
  tool: string;
  caller: string;
  ok: boolean;
  status: number;
  durationMs: number;
}

// One line per tool call, JSON-shaped for Vercel's log drain. console.log is
// the intended transport for now (visible via `vercel logs`); a real drain
// swaps this function, not its call sites.
export function logToolCall(entry: ToolCallLog): void {
  console.log('tool_call', JSON.stringify(entry));
}
