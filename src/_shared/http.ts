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

export interface HttpClient {
  (
    url: string,
    method?: string,
    body?: Record<string, unknown>
  ): Promise<unknown>;
}

export function createHttpClient(deps: {
  apiKey: string;
  fetch: FetchLike;
  tracking: () => Record<string, string>;
  // Distinct per backend so error messages stay attributable
  // ("Runpod API Error" / "Runpod Serverless API Error").
  errorPrefix: string;
}): HttpClient {
  return async function request(
    url: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const init: RequestInitLike = {
      method,
      headers: buildRequestHeaders(deps.apiKey, deps.tracking),
    };
    if (body && methodSendsBody(method)) {
      init.body = JSON.stringify(body);
    }

    const response = await deps.fetch(url, init);

    if (!response.ok) {
      throw new HttpError(
        deps.errorPrefix,
        response.status,
        await response.text(),
        response.status === 429
          ? rateLimitHint(
              response.headers.get('ratelimit'),
              response.headers.get('retry-after')
            )
          : response.status === 401
            ? EXPIRED_CREDENTIAL_HINT
            : undefined
      );
    }

    // 204 / empty / non-JSON → a uniform success marker (matches today's helpers
    // and covers pod-action responses that return no JSON body).
    return isJsonContentType(response.headers.get('content-type'))
      ? response.json()
      : { success: true, status: response.status };
  };
}
