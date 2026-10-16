// Hosted-only loop breaker. Scripts that poll deleted pods send thousands of
// calls an hour that all 404. Each 404 is counted in the Convex sink per
// hashed account + tool (convex/rateLimit.ts); once the sink says a pair is
// blocked, this instance answers that pair with a retryable 429 until the
// block ends, without calling Convex again.
//
// Successful calls never touch Convex, and every failure path fails open: a
// slow or missing sink only means nothing gets blocked.

import { sinkRouteUrl } from '../alp/sink.js';
import type { RateLimiter } from './ops.js';

const SINK_TIMEOUT_MS = 3_000;

/** The `reason` on this limiter's denials, recorded as blocked_by. */
export const NOT_FOUND_LOOP = 'not_found_loop';

// blockedUntil (epoch ms) per `${key}|${tool}`, shared by every request this
// warm instance serves. Only blocked pairs are stored, and expired ones are
// dropped on the next check.
const blocked = new Map<string, number>();

/** The /ratelimit/not-found route on the same Convex site as the ALP sink. */
export function notFoundSinkUrl(submitUrl: string): string | null {
  return sinkRouteUrl(submitUrl, '/ratelimit/not-found');
}

export interface NotFoundLimiter {
  rateLimiter: RateLimiter;
  onToolResult: (tool: string, status: number) => void;
}

export function createNotFoundLimiter(opts: {
  /** Stable salted hash of the caller (analyticsCallerId). */
  key: string;
  sinkUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Called once per block, when the sink reports that this 404 started it. */
  onBlockStarted?: (tool: string, blockedUntil: number) => void;
}): NotFoundLimiter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  return {
    rateLimiter: async (_caller, tool) => {
      const pair = `${opts.key}|${tool}`;
      const until = blocked.get(pair);
      if (until === undefined) return { allowed: true };
      if (until <= now()) {
        blocked.delete(pair);
        return { allowed: true };
      }
      return {
        allowed: false,
        retryAfterS: Math.ceil((until - now()) / 1000),
        reason: NOT_FOUND_LOOP,
      };
    },
    onToolResult: (tool, status) => {
      if (status !== 404) return;
      const pair = `${opts.key}|${tool}`;
      void fetchImpl(opts.sinkUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ALP-Secret': opts.secret,
        },
        body: JSON.stringify({ key: pair }),
        signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: unknown) => {
          const reply = body as {
            blockedUntil?: unknown;
            started?: unknown;
          } | null;
          const until = reply?.blockedUntil;
          if (typeof until === 'number' && until > now()) {
            blocked.set(pair, until);
            if (reply?.started === true) opts.onBlockStarted?.(tool, until);
          }
        })
        .catch(() => {
          // Fail open: a lost count is fine, a failed tool call is not.
        });
    },
  };
}

/** Test seam: forget every cached block. */
export function resetNotFoundBlocks(): void {
  blocked.clear();
}
