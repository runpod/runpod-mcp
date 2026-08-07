import { rateLimitHint } from './rate-limit.js';

// ============== UNIFIED HTTP CLIENT (REST + Serverless) ==============
// One authenticated JSON client that replaces the byte-identical
// `runpodRequest` + `serverlessRequest` helpers. The adapter
// (src/_shared/backend.ts) resolves the full URL, so this client takes a
// resolved URL — the old `endpointId`-split shape collapses into the path.
//
// GraphQL is intentionally NOT routed through here: it sends no Authorization
// header and has its own `{data,errors}` envelope + error prefix. It stays a
// separate helper through Phase A.
//
// `fetch` and `tracking` are injected so this is unit-testable offline with no
// network and no MCP SDK.

// The shape of a `fetch` request init this client builds. Named so the client's
// internal `init` literal can't drift from what `FetchLike` actually accepts.
interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  // Required so an unbounded request through THIS client is a compile error
  // rather than a test. It says nothing about requests built elsewhere — the
  // GraphQL helper (tools/runtime.ts), the flash auth calls (api/index.ts) and
  // the install wizard each bound their own fetch.
  signal: AbortSignal;
}

type FetchLike = (
  url: string,
  init: RequestInitLike
) => Promise<HttpResponseLike>;

interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
}

// The 401 hint. A 401 from a credentialed request means the credential itself
// is dead (expired/revoked key), not that the request was wrong. Say so — a
// bare "401 - Unauthorized" gives an agent nothing actionable, and on stdio
// (env-var API key) there is no HTTP layer to convert this into a re-auth
// signal. Passed by each CREDENTIALED construction site via `hint` rather than
// baked into the constructor, because whether a credential was sent is caller
// context the class doesn't have: the public GraphQL path sends no
// Authorization header at all, so a 401 from that host (WAF, misconfigured
// RUNPOD_PUBLIC_GRAPHQL_URL) says nothing about the caller's API key — the
// same reasoning that keeps that path off observeUnauthorized (runtime.ts).
// Bare inner text: the constructor adds the ` (…)` wrapping.
export const EXPIRED_CREDENTIAL_HINT =
  'the Runpod API rejected the credential — the API key may be expired or revoked; re-authenticate or update RUNPOD_API_KEY';

// Thrown on any non-OK response. Carries `status` + `body` so callers can
// branch (e.g. create-pod maps a 501 to a clean "CPU pods not yet supported"
// message) without parsing the message string. Because it still THROWS, loops
// that count consecutive errors (e.g. stream-job) keep working — a 501 mid-poll
// is surfaced as an error, not swallowed. Status-specific hints need caller
// context (the 429 RateLimit header, whether a 401's request was credentialed),
// so all of them arrive via `hint`.
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(prefix: string, status: number, body: string, hint?: string) {
    // The body is embedded in the message for readability but capped: a WAF or
    // proxy error page can run to hundreds of KB, and the message lands
    // verbatim in an agent's context. `.body` keeps the full text for
    // programmatic callers.
    const shownBody =
      body.length > 2048
        ? `${body.slice(0, 2048)}… [truncated ${body.length - 2048} chars]`
        : body;
    super(`${prefix}: ${status} - ${shownBody}${hint ? ` (${hint})` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

// ============== REQUEST DEADLINE ==============
// node-fetch has no timeout of its own, so a server that accepts the connection
// then goes silent leaves the request pending until the platform reaps the
// function — a bare 504, with whatever the tool had collected thrown away.
// Same mechanism as credential-check.ts and backend.ts.
//
// 30s is generous for a control-plane call that answers sub-second, and leaves
// the hosted function room to serialize a real error. runsync-endpoint asks the
// server to hold the connection open, so it raises its own (tools/jobs.ts).
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// Floor for a deadline shrunk by a nearly-spent invocation budget (see
// `maxTimeoutMs`). A 0ms deadline aborts before the socket opens and reports
// "no response after 0ms", which reads as a server fault rather than a budget
// we had already used up; a second is enough for a warm host to answer, and
// overshooting an exhausted budget by 1s is strictly better than the bare 504
// the whole deadline exists to replace.
export const MIN_REQUEST_TIMEOUT_MS = 1_000;

// A bare AbortError names neither the API nor the deadline, and the MCP SDK
// hands that string straight to the agent.
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly method: string;
  constructor(prefix: string, timeoutMs: number, method: string) {
    // We abandoned the request, we did not undo it, and nothing sends an
    // idempotency key — so a timed-out write may well have landed. Retry advice
    // has to key off the method or an agent double-creates a billed resource.
    const write = method !== 'GET' && method !== 'HEAD';
    super(
      `${prefix}: no response after ${timeoutMs}ms for ${method} (the API may be overloaded, or still be working on it). ${
        write
          ? 'This request may have SUCCEEDED upstream — do not retry blindly. Check with the matching list-/get- tool first and retry only if it did not take effect.'
          : 'This was a read and changed nothing, so retrying is safe.'
      }`
    );
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
    this.method = method;
  }
}

// Covers the whole exchange, not just the connect: a server can send headers
// then stall mid-body. Shared with the GraphQL helper in tools/runtime.ts,
// which builds its own request but has the same failure mode.
export async function withRequestTimeout<T>(
  errorPrefix: string,
  timeoutMs: number,
  method: string,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await run(signal);
  } catch (error) {
    // `signal.aborted`, not an error name: node-fetch, undici and the test
    // fakes each label an abort differently. A real status beats a timeout.
    if (error instanceof HttpError || !signal.aborted) throw error;
    throw new RequestTimeoutError(errorPrefix, timeoutMs, method);
  }
}

// A response whose content-type marks it as JSON — including v2's RFC-9457
// `application/problem+json` error bodies. We match the `+json`/`/json` shape,
// NOT the literal substring `application/json` (which `problem+json` does not
// contain), so v2 error bodies are parsed rather than swallowed.
function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('application/json') || ct.includes('+json');
}

// Body-carrying methods. This is now the single unified client for all REST
// calls, so include PUT — otherwise a future tool passing method='PUT' with a
// body would have the payload silently dropped (request sent with no body, no
// error). GET/DELETE never carry a body.
function methodSendsBody(method: string): boolean {
  return method === 'POST' || method === 'PATCH' || method === 'PUT';
}

// The auth + content-type + caller-tracking headers sent on every request.
function buildRequestHeaders(
  apiKey: string,
  tracking: () => Record<string, string>
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...tracking(),
  };
}

// Trailing and optional so existing call sites are untouched and only the
// calls that need a different deadline mention one.
export interface RequestOptions {
  // Clamped by the client's `maxTimeoutMs`. Only runsync-endpoint sets it.
  timeoutMs?: number;
}

// A per-request deadline bounds one stalled socket; it does not bound a handler
// that makes several calls in a row. get-job-status (status, then the queued-job
// diagnosis), deploy-hub-repo (catalog, then the saveEndpoint mutation) and
// update-endpoint (read the scaler, then PATCH) each issue two, so two default
// deadlines back to back outlast the platform and the 504 comes back.
//
// So the hosted ceiling is a function, not a constant: it reports what is left
// of the whole invocation, and every request is clamped to that. The first call
// may take the lot; the second only gets the remainder.
export type TimeoutCeiling = number | (() => number);

function resolveCeiling(ceiling: TimeoutCeiling | undefined): number {
  if (ceiling === undefined) return Infinity;
  // Only a thunk gets the floor. It is the one that decays as the invocation is
  // spent and so can reach zero on its own; a static ceiling is a number
  // someone chose, and silently raising it would be the surprise.
  if (typeof ceiling !== 'function') return ceiling;
  return Math.max(ceiling(), MIN_REQUEST_TIMEOUT_MS);
}

// Honoring an override past the platform limit just trades the named timeout
// back for the 504 it exists to replace. Shared with the GraphQL helper in
// tools/runtime.ts, which builds its own request but is under the same budget.
export function clampTimeout(
  requestedMs: number | undefined,
  ceiling: TimeoutCeiling | undefined,
  defaultMs: number = DEFAULT_REQUEST_TIMEOUT_MS
): number {
  return Math.min(requestedMs ?? defaultMs, resolveCeiling(ceiling));
}

export interface HttpClient {
  (
    url: string,
    method?: string,
    body?: Record<string, unknown>,
    options?: RequestOptions
  ): Promise<unknown>;
}

export function createHttpClient(deps: {
  apiKey: string;
  fetch: FetchLike;
  tracking: () => Record<string, string>;
  // Distinct per backend so error messages stay attributable
  // ("Runpod API Error" / "Runpod Serverless API Error").
  errorPrefix: string;
  // Deadline for calls that pass no `timeoutMs` of their own.
  defaultTimeoutMs?: number;
  // Ceiling on the default and on any override, for a caller under a platform
  // deadline it cannot outlive (HTTP_TRANSPORT_BUDGET_MS in tools/runtime.ts).
  // A thunk re-reads the remaining budget per call. Unset = no ceiling.
  maxTimeoutMs?: TimeoutCeiling;
}): HttpClient {
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  return async function request(
    url: string,
    method: string = 'GET',
    body?: Record<string, unknown>,
    options?: RequestOptions
  ): Promise<unknown> {
    const timeoutMs = clampTimeout(
      options?.timeoutMs,
      deps.maxTimeoutMs,
      defaultTimeoutMs
    );

    return withRequestTimeout(
      deps.errorPrefix,
      timeoutMs,
      method,
      async (signal) => {
        const init: RequestInitLike = {
          method,
          headers: buildRequestHeaders(deps.apiKey, deps.tracking),
          signal,
        };
        if (body && methodSendsBody(method)) {
          init.body = JSON.stringify(body);
        }

        const response = await deps.fetch(url, init);

        if (!response.ok) {
          // Status and hint first: the body is awaited as a constructor
          // argument, so a deadline firing mid-drain would reject before the
          // HttpError exists and lose the 429 retry hint / 401 re-auth signal.
          const hint =
            response.status === 429
              ? rateLimitHint(
                  response.headers.get('ratelimit'),
                  response.headers.get('retry-after')
                )
              : response.status === 401
                ? EXPIRED_CREDENTIAL_HINT
                : undefined;
          const text = await response
            .text()
            .catch(
              () => '<body unavailable: the connection closed while reading it>'
            );
          throw new HttpError(deps.errorPrefix, response.status, text, hint);
        }

        // 204 / empty / non-JSON → a uniform success marker (matches today's
        // helpers and covers pod-action responses that return no JSON body).
        return isJsonContentType(response.headers.get('content-type'))
          ? response.json()
          : { success: true, status: response.status };
      }
    );
  };
}
