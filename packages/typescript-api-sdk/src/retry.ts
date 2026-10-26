import { getRateLimitInfo } from "./rate-limit.js";
export { parseRetryAfter } from "./rate-limit.js";

// Shared retry policy for every RunPod API call, as a fetch wrapper.
//
// Policy: idempotent requests (GET, HEAD, PUT, DELETE, OPTIONS) retry on 429,
// on 500/502/503/504, and on network errors. Non-idempotent requests (POST,
// PATCH) retry ONLY on 429 — a 5xx may mean the API already performed the
// mutation, and a blind replay can double-create. A Retry-After header
// (delay-seconds or HTTP-date, RFC 9110 §10.2.3) is respected up to
// the wait ceiling; longer waits return the response instead of retrying early. Otherwise delay is exponential backoff with equal jitter.
// An aborted request is never retried: the caller's deadline is the ceiling.

export interface RetryOptions {
  maxAttempts?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetryAfterMs?: number;
  /** Base fetch to wrap; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Random source for jitter, injectable for deterministic tests. */
  random?: () => number;
  /** Sleep implementation, injectable for fast tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  maxAttempts: 4,
  minBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  maxRetryAfterMs: 60_000,
};

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

/**
 * True for any abort rejection: `AbortController.abort()` raises `AbortError`
 * and `AbortSignal.timeout()` raises `TimeoutError`, as a DOMException in Node
 * and often as a plain Error in a fetch polyfill. Retrying either one would
 * blow through the deadline the caller asked for.
 */
function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function shouldRetry(method: string, response: Response | undefined): boolean {
  const idempotent = IDEMPOTENT_METHODS.has(method);
  if (response === undefined) return idempotent; // network error
  if (response.status === 429) return true; // not processed; safe for any method
  return idempotent && RETRYABLE_STATUS.has(response.status);
}

/** Stop backoff immediately on abort, including custom abort reasons. */
function sleepWithSignal(ms: number, signal: AbortSignal, custom?: RetryOptions["sleep"]): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => { cleanup(); resolve(); };
    if (custom) {
      // The injected work cannot be cancelled, but its rejection is handled and
      // the request stops waiting for it as soon as the caller aborts.
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return custom(ms);
      }).then(done, (error) => { cleanup(); reject(error); });
    } else {
      timer = setTimeout(done, ms);
    }
  });
}

/** Wraps a fetch implementation with the RunPod retry policy. */
export function createRetryFetch(options: RetryOptions = {}): typeof fetch {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const minBackoffMs = options.minBackoffMs ?? DEFAULTS.minBackoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs;
  const baseFetch = options.fetch ?? globalThis.fetch;
  const random = options.random ?? Math.random;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer");
  }
  for (const [name, value] of Object.entries({ minBackoffMs, maxBackoffMs, maxRetryAfterMs })) {
    if (!Number.isFinite(value) || value < 0 || value > 2_147_483_647) {
      throw new RangeError(`${name} must be finite and between 0 and 2147483647`);
    }
  }
  if (minBackoffMs > maxBackoffMs) {
    throw new RangeError("minBackoffMs must not exceed maxBackoffMs");
  }

  return async (input, init) => {
    // The original request is never sent, only cloned, so its body stays
    // readable for every attempt.
    const original = new Request(input, init);

    for (let attempt = 1; ; attempt++) {
      original.signal.throwIfAborted();
      let response: Response | undefined;
      let networkError: unknown;
      try {
        response = await baseFetch(original.clone());
      } catch (error) {
        original.signal.throwIfAborted();
        if (isAbortError(error)) throw error;
        networkError = error;
      }

      if (response !== undefined && !shouldRetry(original.method, response)) return response;
      if (response === undefined && !shouldRetry(original.method, undefined)) throw networkError;
      if (attempt >= maxAttempts) {
        if (response !== undefined) return response;
        throw networkError;
      }

      const rateLimit = response ? getRateLimitInfo(response.headers) : undefined;
      let delay = rateLimit?.retryDelayMs;
      // A wait ceiling is not permission to retry sooner than the server allows.
      if (response && (rateLimit?.incomplete || (delay !== undefined && delay > maxRetryAfterMs))) return response;
      if (delay === undefined) {
        const shift = Math.min(attempt - 1, 20);
        const backoff = Math.min(minBackoffMs * 2 ** shift, maxBackoffMs);
        // Equal jitter over [backoff/2, backoff].
        delay = backoff / 2 + random() * (backoff / 2);
      }
      await response?.body?.cancel();
      await sleepWithSignal(delay, original.signal, options.sleep);
    }
  };
}
