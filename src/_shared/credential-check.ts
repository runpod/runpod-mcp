// ============== HOSTED CREDENTIAL PRE-FLIGHT ==============
// The hosted HTTP server forwards the caller's Bearer token straight to the
// Runpod API. When that credential dies mid-session (the OAuth-minted key
// is revoked), every tool call fails upstream with a 401 — but the
// MCP SDK wraps thrown tool errors into a 200 JSON-RPC tool result, so the
// client never sees an HTTP 401 and never re-runs its OAuth flow. The user is
// stuck with bare "Unauthorized" tool errors until they manually reconnect.
//
// This module verifies the credential BEFORE the MCP request is handled, so
// a dead credential turns into a proper HTTP 401 + WWW-Authenticate response
// (src/http.ts writeUnauthorized) — the signal OAuth-capable MCP clients use
// to re-authenticate automatically.
//
// Verification is one authenticated `myself { id }` GraphQL query. Observed live:
//   - never-valid key      → HTTP 401
//   - anonymous (no ident) → HTTP 200 with `myself: null`
//   - valid key            → HTTP 200 with `myself.id`
//
// NOT yet observed: what a once-valid, since-REVOKED key returns. The assumption
// is HTTP 401, same as a key that never existed — but if it instead answers
// `{data: null, errors: [...]}` that lands in the indeterminate branch below and
// the gate fails open, silently never firing for the case it exists for. Probe a
// genuinely revoked key to settle it.
// Verdicts are cached in-memory by token hash (never the raw token) so a warm
// instance adds no per-request latency: valid verdicts live for a few minutes,
// invalid ones briefly (a just-reauthorized user shouldn't wait long). Network
// failures and 5xx responses FAIL OPEN — the request proceeds and the tools
// surface the real upstream error — so an auth-backend blip can't take down
// the whole server.

import { createHash } from 'node:crypto';

// `unknown` is the fail-open case: the request proceeds, but it is a GUESS and is
// never cached — caching one lets a revoked credential skip the 401 for a full
// TTL, which is the behaviour this module exists to remove.
export type CredentialVerdict =
  | { status: 'valid' }
  | { status: 'invalid'; reason: string }
  | { status: 'unknown' };

export type CredentialChecker = (token: string) => Promise<CredentialVerdict>;

// A checker plus the hook needed to correct a stale verdict (see invalidate).
export interface CredentialCheckerHandle {
  verify: CredentialChecker;
  // Drop a cached verdict. Called when a tool's own upstream call 401s, which
  // proves the cached "valid" wrong sooner than its TTL would.
  invalidate: (token: string) => void;
}

// Named AuthProbeFetch/AuthProbeResponse, not FetchLike: kept distinct from
// the fetch-shaped types the specgen clients use, since this probe needs only
// this narrow shape.
interface AuthProbeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type AuthProbeFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<AuthProbeResponse>;

// A valid verdict is short-lived on purpose. It bounds how long a key revoked
// mid-session keeps passing the gate and failing upstream instead — the exact
// experience this module exists to remove — for the cost of one cheap query a
// minute per active token.
const VALID_TTL_MS = 60_000;
const INVALID_TTL_MS = 30_000;
// The pre-flight blocks the MCP request, so a slow auth backend must not be
// able to hold it open. Without this the request hangs until the platform's own
// limit (Vercel maxDuration 60s) turns it into a 504 — failing OPEN covers an
// erroring backend but not a slow one. Mirrors the old backend resolver's probe deadline.
const REQUEST_TIMEOUT_MS = 4000;
// Cap so a stream of one-off tokens cannot grow the map without bound: entries
// expire lazily (only on a repeat lookup of the same token), and an unauthed
// caller can mint arbitrarily many distinct tokens.
const MAX_CACHE_ENTRIES = 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createCredentialChecker(deps: {
  fetch: AuthProbeFetch;
  // Resolved per call so an env change takes effect without a module reload
  // (matches how the tool runtime resolves its base URLs).
  url: () => string;
  now?: () => number;
  validTtlMs?: number;
  invalidTtlMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
}): CredentialCheckerHandle {
  // Monotonic by default, not Date.now: TTLs are elapsed-time bounds, and a
  // wall-clock step backwards (NTP/VM correction) against an absolute Date.now
  // stamp would silently extend a cached verdict well past its TTL — turning the
  // documented ~60s revocation bound into minutes. Tests inject their own `now`.
  const now = deps.now ?? (() => performance.now());
  const validTtl = deps.validTtlMs ?? VALID_TTL_MS;
  const invalidTtl = deps.invalidTtlMs ?? INVALID_TTL_MS;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  // Clamped so the two call sites below need no degenerate-case guards.
  const maxEntries = Math.max(1, deps.maxEntries ?? MAX_CACHE_ENTRIES);
  // ONE entry per token: either a check in flight or a settled verdict. A
  // settling check writes its result only if the entry it started with is still
  // the one in the map, and invalidate() removes the entry — so a check already
  // running when a credential is rejected cannot resurrect its stale verdict.
  //
  // Insertion-ordered, so this doubles as the LRU: a hit re-inserts to move the
  // key to the back (see verify), and eviction takes the front.
  interface Entry {
    // Set while a check is running; cleared once it settles.
    promise?: Promise<CredentialVerdict>;
    // Set once a DEFINITIVE answer arrives. An indeterminate fail-open is never
    // stored — it is a guess, and caching a guess for a full TTL lets a dead
    // credential skip the 401 for that window, the bug this module exists to fix.
    verdict?: CredentialVerdict;
    expiresAt: number;
  }
  const entries = new Map<string, Entry>();

  async function fetchVerdict(token: string): Promise<CredentialVerdict> {
    try {
      const response = await deps.fetch(deps.url(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: 'query { myself { id } }' }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status === 401) {
        return {
          status: 'invalid',
          reason:
            'The Runpod API rejected the credential (it may have been revoked).',
        };
      }
      // 403 is NOT a dead credential. This host sits behind Cloudflare, so a
      // WAF/bot block answers 403 with no relation to the token, and a
      // permission-scoped key can 403 while still working for other calls.
      // Treating it as dead sent a 401 back, the client re-ran OAuth, and that
      // MINTS A NEW API KEY on every attempt — a loop that never recovers and
      // fills the user's dashboard with keys. Fail open and let the tool
      // surface the real error.
      if (!response.ok) return { status: 'unknown' };

      const result = (await response.json()) as {
        data?: { myself?: { id?: string } | null };
        errors?: unknown[];
      };
      if (result?.data?.myself?.id) return { status: 'valid' };
      // A GraphQL response that carries errors is NOT authoritative about the
      // credential. Per the GraphQL spec a resolver failure on the nullable
      // `myself` field answers HTTP 200 with `myself: null` AND an `errors`
      // array — that null reflects a server-side fault, not a dead token. The
      // shape is identical for every caller during a backend blip, so treating
      // it as `invalid` would 401 EVERY valid credential at once and drive every
      // OAuth client into the re-auth key-minting loop the 403 branch above
      // exists to prevent — and it fails closed, which is worse than 403's
      // fail-open. So fail open on any errors; a genuine anonymous token returns
      // a clean `myself: null` with no errors (verified live).
      if (Array.isArray(result?.errors) && result.errors.length > 0) {
        return { status: 'unknown' };
      }
      if (result?.data && result.data.myself === null) {
        // The backend treated the request as anonymous — the token carries no
        // identity, so every downstream call would 401.
        return {
          status: 'invalid',
          reason: 'The credential does not resolve to a Runpod account.',
        };
      }
      // Unrecognized shape (including a bare {data: null}) — fail open.
      return { status: 'unknown' };
    } catch {
      // Network error, or the timeout above aborting — fail open.
      return { status: 'unknown' };
    }
  }

  function evictIfFull(): void {
    // Never evict an entry whose check is still in flight. Doing so disowns a
    // registered check — its settle handler then fails the `entries.get(key) ===
    // entry` identity test and drops its verdict — which breaks the one-in-flight-
    // check-per-token invariant that makes last-writer-wins safe. Without this a
    // flood of distinct tokens (each cached as a definitive `invalid`, so they
    // hold the map full) could evict a legitimate user's in-flight check and let
    // a since-revoked key cache as `valid` for a full TTL, and duplicate the
    // upstream call. Only settled entries are evicted, oldest first (insertion
    // order = LRU). If every entry is in flight we allow a brief, bounded
    // overshoot: in-flight count is capped by request concurrency and each check
    // self-clears within the request timeout.
    while (entries.size >= maxEntries) {
      let victim: string | undefined;
      for (const [k, e] of entries) {
        if (!e.promise) {
          victim = k;
          break;
        }
      }
      if (victim === undefined) return;
      entries.delete(victim);
    }
  }

  async function verify(token: string): Promise<CredentialVerdict> {
    const key = hashToken(token);
    const existing = entries.get(key);

    if (existing?.verdict) {
      if (existing.expiresAt > now()) {
        // Refresh recency so a hot token is not evicted ahead of a cold one.
        entries.delete(key);
        entries.set(key, existing);
        return existing.verdict;
      }
      entries.delete(key);
    } else if (existing?.promise) {
      // Join the check already running for this token rather than duplicating it.
      return existing.promise;
    }

    const entry: Entry = { expiresAt: 0 };
    entry.promise = fetchVerdict(token).then((verdict) => {
      // Only RECORD the result if this entry is still the one registered. A
      // different entry means invalidate() removed ours, or a newer check
      // replaced it, so this answer must not be stored — and must not delete the
      // newer entry either. The caller that started this check is still served
      // its own result; only the shared state is protected.
      if (entries.get(key) === entry) {
        if (verdict.status !== 'unknown') {
          entry.verdict = verdict;
          entry.expiresAt =
            now() + (verdict.status === 'valid' ? validTtl : invalidTtl);
          entry.promise = undefined;
        } else {
          entries.delete(key);
        }
      }
      return verdict;
    });

    evictIfFull();
    entries.set(key, entry);
    return entry.promise;
  }

  return {
    verify,
    invalidate: (token: string) => {
      // Removing the entry is the whole mechanism: a check already in flight can
      // no longer match it on settle, so it cannot resurrect the verdict this
      // call just rejected. Nothing to prune afterwards, so nothing can leak.
      entries.delete(hashToken(token));
    },
  };
}
