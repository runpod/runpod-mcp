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

type FetchLike = (url: string, init: RequestInitLike) => Promise<HttpResponseLike>;

interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
  headers: { get(name: string): string | null };
}

// Thrown on any non-OK response. Carries `status` + `body` so callers can
// branch (e.g. create-pod maps a 501 to a clean "CPU pods not yet supported"
// message) without parsing the message string. Because it still THROWS, loops
// that count consecutive errors (e.g. stream-job) keep working — a 501 mid-poll
// is surfaced as an error, not swallowed.
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(prefix: string, status: number, body: string) {
    super(`${prefix}: ${status} - ${body}`);
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
        await response.text()
      );
    }

    // 204 / empty / non-JSON → a uniform success marker (matches today's helpers
    // and covers pod-action responses that return no JSON body).
    return isJsonContentType(response.headers.get('content-type'))
      ? response.json()
      : { success: true, status: response.status };
  };
}
