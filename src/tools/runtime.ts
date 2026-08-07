import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';
import {
  clampTimeout,
  createHttpClient,
  EXPIRED_CREDENTIAL_HINT,
  HttpError,
  withRequestTimeout,
  type RequestOptions,
  type TimeoutCeiling,
} from '../_shared/http.js';
import { rateLimitHint } from '../_shared/rate-limit.js';
import { buildTrackingHeaders } from '../_shared/tracking.js';
import { readSseSnapshot, type SseFetch } from './logs.js';
import {
  resolveBackend,
  restV1Base,
  serverlessBase,
  publicGraphqlBase,
  authedGraphqlBase,
  type Env,
  type Backend,
  type Resource,
} from '../_shared/backend.js';

// ============== TOOL RUNTIME (shared per-server wiring) ==============
// The per-resource tool modules (src/tools/<resource>.ts) are pure registration
// functions: each takes the MCP server + this runtime and calls server.tool(...).
// Everything that depends on the live server instance or the caller's API key —
// caller-tracking, the authenticated request clients, the v1/v2 backend resolver
// — is built ONCE here by createToolRuntime and threaded in, so the resource
// modules stay free of wiring and are individually testable.

// Base URLs are resolved LIVE per call (via restV1Base/serverlessBase/
// publicGraphqlBase reading process.env), not frozen at module import — so they
// match callRestUrl's behavior and a test/env change takes effect without a
// module reload. The defaults live in _shared/backend.ts. Three distinct
// GraphQL hosts: publicGraphqlBase (credential-free), authedGraphqlBase (the
// only one this module sends the caller's API key to), and RUNPOD_GRAPHQL_URL
// (flash OAuth flow in api/index.ts only).

// ============== CALLER TRACKING ==============
// Adds structured caller identification to every outbound API call so the
// Runpod platform can attribute traffic to a specific MCP client (Claude Code,
// Cursor, Codex, Gemini CLI, etc.) and count distinct agent sessions. Pure
// observability — no tool behavior changes.
//
// `__PACKAGE_VERSION__` is replaced at build time by tsup's `define` with the
// current `version` from package.json. Falls back to `'dev'` when the
// substitution doesn't happen (e.g. `pnpm dev` via tsx).
declare const __PACKAGE_VERSION__: string;
const MCP_SERVER_VERSION =
  typeof __PACKAGE_VERSION__ !== 'undefined' ? __PACKAGE_VERSION__ : 'dev';

// One session ID per server process. Anonymous; lets the data side count
// distinct agent sessions without per-user attribution.
const SESSION_ID = randomUUID();

/**
 * Context passed to every tool handler. Contains the API key used to
 * authenticate against the Runpod REST and Serverless APIs, the transport the
 * server is running under, and (for stateless HTTP) the inbound client
 * User-Agent — all used for outbound caller-tracking headers.
 */
export interface ToolContext {
  apiKey: string;
  transport: 'stdio' | 'http';
  clientUserAgent?: string;
  serverVersion?: string;
  // Called when an outbound call answers 401, i.e. the credential just died.
  // The hosted server uses it to drop the cached pre-flight verdict so the very
  // next request re-checks and can emit the 401 + WWW-Authenticate that makes a
  // client re-authenticate, instead of waiting out the cache TTL.
  onUnauthorized?: () => void;
}

/**
 * Builds the headers that identify the calling MCP client and session on every
 * outbound HTTP call. Client identity comes from the `initialize` handshake's
 * `clientInfo` (exposed by the SDK via `server.server.getClientVersion()`),
 * which works for the long-lived stdio server. In stateless HTTP that handshake
 * is on a different request, so we fall back to the inbound HTTP User-Agent.
 *
 * Resolution of clientInfo → fallback happens here (the SDK touch); the pure
 * string formatting lives in `_shared/tracking.ts`.
 */
function trackingHeaders(
  server: McpServer,
  ctx: ToolContext
): Record<string, string> {
  const info = server.server.getClientVersion();
  return buildTrackingHeaders({
    clientName: info?.name || ctx.clientUserAgent || 'unknown',
    clientVersion: info?.version || 'unknown',
    transport: ctx.transport,
    // Prefer a server version supplied by the caller (the hosted entrypoint reads
    // it from package.json at runtime, since tsup's build-time define does not
    // run when Vercel compiles api/index.ts). Fall back to the build-time value.
    serverVersion: ctx.serverVersion || MCP_SERVER_VERSION,
    sessionId: SESSION_ID,
  });
}

// A BACKSTOP for a wedged socket, not a budget. It has to clear the wait
// runsync asks the server to hold (or we abort a reply in flight) and still
// fire before the platform — measured from the INVOCATION, which starts with
// the 4s credential pre-flight, not from our request. That is what makes 55s
// wrong. Both bounds asserted in tests/http.test.ts.
//
//   0s   invocation starts
//   4s   credential pre-flight, worst case, before any tool request
//   54s  this backstop fires
//   60s  vercel.json maxDuration
export const HTTP_TRANSPORT_BUDGET_MS = 50_000;

// Spent across the whole invocation, not per request: a handler that issues two
// calls (get-job-status, deploy-hub-repo, update-endpoint) would otherwise get
// two full deadlines and outlive the platform anyway. Safe to anchor at runtime
// construction because on http the server, and so this runtime, is built per
// request and disposed with the response (src/http.ts).
// Exported for the test that pins the reset: if registerTools were ever hoisted
// out of the http request handler to save cold-start time, this window would
// keep decaying across requests and every request after the first would run on
// the floor — a silent, load-shaped failure rather than an obvious one.
export function invocationBudget(totalMs: number): () => number {
  const startedAt = Date.now();
  return () => totalMs - (Date.now() - startedAt);
}

// The fetch implementation the unified client uses. Defaults to node-fetch;
// tests inject a fake to capture outbound requests offline (the A4 seam).
export type HttpFetch = Parameters<typeof createHttpClient>[0]['fetch'];
const defaultFetch = fetch as HttpFetch;

// Wrap a unified-client call with the legacy `console.error(label) + re-throw`
// the pre-adapter runpodRequest/serverlessRequest helpers had. Centralizes the
// identical try/catch blocks into one place.
async function withApiErrorLog<T>(
  label: string,
  call: () => Promise<T>
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    console.error(label, error);
    throw error;
  }
}

// The standard MCP tool reply: a single text block holding pretty-printed JSON.
// Every tool returns this shape.
export function jsonReply(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

// Shared MCP tool-annotation presets (advisory hints clients use to label tools
// and gate confirmations). `openWorldHint` is true on all of these — every tool
// talks to the external Runpod API. READ_ONLY = pure reads; WRITE = creates/
// mutations; DESTRUCTIVE = deletes (also idempotent: re-deleting a gone resource
// is a no-op). Spread a preset and add a per-tool `title`.
export const READ_ONLY = { readOnlyHint: true, openWorldHint: true };
export const WRITE = { readOnlyHint: false, openWorldHint: true };
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

// Optional test seam: inject a fake fetch to capture outbound requests offline.
// Production passes nothing → node-fetch. `v2Available` is the already-resolved
// stdio `auto`-probe verdict (see backend.resolveVersion); omitted → `auto`
// resolves to v1.
export interface ToolDeps {
  fetch?: HttpFetch;
  v2Available?: boolean;
  // Test seam for the SSE log stream (stream-pod-logs). Production builds a
  // node-fetch reader; tests inject a fake returning canned event-stream text.
  streamSse?: StreamSse;
  // Lower-level seam: the fetch the SSE reader uses. `streamSse` replaces the
  // whole reader (and so bypasses the 401 observer); this replaces only its
  // transport, which is what lets a test drive an SSE 401 through the observer.
  sseFetch?: SseFetch;
  // Test seam: shrink the deadline so a suite need not wait out the real one.
  defaultTimeoutMs?: number;
  // Ceiling on every request's deadline, including one a tool asks to lengthen
  // (stream-job's per-poll hold, runsync's ?wait=). The hosted transport
  // installs the remaining invocation budget here; a test pins it low so a
  // stalled socket aborts in milliseconds instead of seconds.
  maxTimeoutMs?: TimeoutCeiling;
}

// A bounded Server-Sent-Events read. Returns the raw accumulated stream text
// (caller parses frames) plus whether the byte cap truncated it. Time-bounded
// by maxWaitMs (the stream may stay open for live tail), so a clean timeout is
// a normal end, not an error.
export interface StreamSseResult {
  raw: string;
  truncated: boolean;
}
export type StreamSse = (
  url: string,
  opts: { maxWaitMs: number; maxBytes: number }
) => Promise<StreamSseResult>;

/**
 * The shared, server-instance-bound runtime threaded into every per-resource
 * registrar. Built once by createToolRuntime.
 */
export interface ToolRuntime {
  // Pretty-printed JSON reply helper (re-exported for convenience).
  jsonReply: typeof jsonReply;
  // Public, no-auth GraphQL query against the Runpod GraphQL endpoint.
  graphql: <T>(query: string) => Promise<T>;
  // Authenticated GraphQL operation (API-key Bearer) against the same endpoint,
  // with variables support — the authenticated path accepts them (the public,
  // unauthenticated path does not). Used for console-only operations that have
  // no REST home yet (e.g. deploying a Hub release via saveEndpoint).
  graphqlAuthed: <T>(
    query: string,
    variables?: Record<string, unknown>
  ) => Promise<T>;
  // Authenticated v1 REST call, path-relative to the v1 base (e.g. `/endpoints`).

  runpodRequest: (
    endpoint: string,
    method?: string,
    body?: Record<string, unknown>,
    options?: RequestOptions
  ) => Promise<unknown>;
  // Authenticated Serverless runtime call (api.runpod.ai/v2/{endpointId}{path}).
  serverlessRequest: (
    endpointId: string,
    path: string,
    method?: string,
    body?: Record<string, unknown>,
    options?: RequestOptions
  ) => Promise<unknown>;
  // Authenticated REST call to a fully-resolved URL (the adapter builds the URL).
  callRestUrl: (
    url: string,
    method?: string,
    body?: Record<string, unknown>,
    options?: RequestOptions
  ) => Promise<unknown>;
  // Resolve a resource's v1/v2 backend descriptor for the current env/transport.
  backendFor: (resource: Resource) => Backend;
  // Bounded SSE reader (stream-pod-logs). Authenticated + tracked; reads a
  // text/event-stream until the byte cap or the time bound, returning the raw
  // accumulated text. Throws HttpError on a non-OK response.
  streamSse: StreamSse;
  // Pod state transition (v1 subpaths vs v2 unified /action).
  podAction: (
    podId: string,
    action: 'start' | 'stop' | 'restart'
  ) => Promise<unknown>;
  // The process env, exposed for the few handlers that resolve base URLs
  // directly (e.g. create-pod's CPU → v1 fallback).
  env: Env;
  // Which transport this server runs under. The hosted HTTP server lives inside
  // a serverless function with a hard platform deadline (Vercel maxDuration),
  // so long-poll tools clamp their wait budgets on 'http' (see jobs.ts) instead
  // of planning more seconds than the platform will give them.
  transport: 'stdio' | 'http';
}

// Helper to make GraphQL requests to Runpod (public, no auth required). Bound to
// the per-request tracking headers AND the injected fetch by createToolRuntime —
// it must use the same `httpFetch` seam as the REST clients, NOT the module-level
// node-fetch, or test fakes wouldn't intercept the v1 catalog (list-gpu-types /
// list-data-centers) GraphQL calls and those "offline" goldens would hit the net.
async function graphqlRequest<T>(
  query: string,
  tracking: () => Record<string, string>,
  fetchImpl: HttpFetch,
  url: string,
  options?: {
    variables?: Record<string, unknown>;
    apiKey?: string;
    // See http.ts.
    timeoutMs?: number;
    // Remaining invocation budget, same thunk the REST clients are capped by.
    // deploy-hub-repo spends two GraphQL calls in one invocation.
    maxTimeoutMs?: TimeoutCeiling;
  }
): Promise<T> {
  // Builds its own request rather than going through createHttpClient, so the
  // deadline is wired separately — otherwise list-gpu-types / get-capacity
  // against a wedged host hang the way the REST calls used to.
  return withRequestTimeout(
    'Runpod GraphQL Error',
    clampTimeout(options?.timeoutMs, options?.maxTimeoutMs),
    // GraphQL is POST on the wire whatever it carries, but the retry advice keys
    // off the method, and telling a caller its list-gpu-types "may have
    // SUCCEEDED upstream — check with the matching list-/get- tool first" points
    // it back at the tool that just failed. The operation keyword is what
    // actually says whether anything could have been written.
    isGraphqlMutation(query) ? 'POST' : 'GET',
    (signal) => runGraphql<T>(query, tracking, fetchImpl, url, signal, options)
  );
}

// Anonymous operations (`{ gpuTypes { ... } }`) and the explicit `query` keyword
// are both reads; only `mutation` writes. Leading whitespace and comments are
// the shapes that actually occur in this file's template literals.
export function isGraphqlMutation(query: string): boolean {
  const firstMeaningful = query
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('#'));
  return /^mutation\b/.test(firstMeaningful ?? '');
}

async function runGraphql<T>(
  query: string,
  tracking: () => Record<string, string>,
  fetchImpl: HttpFetch,
  url: string,
  signal: AbortSignal,
  options?: {
    variables?: Record<string, unknown>;
    apiKey?: string;
  }
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
      ...tracking(),
    },
    body: JSON.stringify({
      query,
      ...(options?.variables ? { variables: options.variables } : {}),
    }),
    signal,
  });

  // HTTP-level failures used to fall through to response.json() and surface
  // as an opaque parse error ("Unexpected token '<'" for a 429/5xx HTML
  // body). Handle them like the REST client (http.ts): status + body + a
  // wait hint on 429. A non-OK response whose body still carries a GraphQL
  // errors array keeps the readable GraphQL message (servers commonly return
  // 400 for malformed queries), with the status attached.
  if (!response.ok) {
    const bodyText = await response.text();
    let gqlErrors: Array<{ message: string }> | undefined;
    try {
      gqlErrors = (
        JSON.parse(bodyText) as { errors?: Array<{ message: string }> }
      ).errors;
    } catch {
      // Not JSON (HTML error page, empty body) — the HttpError below carries
      // the raw body instead.
    }
    // Array.isArray, not truthiness: proxies/WAFs emit shapes like
    // {"errors":"internal failure"}, where a non-empty string passes a
    // .length check and then .map() throws — a worse error than the parse
    // error this handling exists to eliminate. 401/429 fall through to
    // the hinted HttpError below, so the re-auth and rate-limit hints are
    // never suppressed by a prettier message. Still an HttpError (with the
    // extracted messages as the body) so `.status` stays machine-readable.
    if (
      Array.isArray(gqlErrors) &&
      gqlErrors.length > 0 &&
      response.status !== 401 &&
      response.status !== 429
    ) {
      throw new HttpError(
        'Runpod GraphQL Error',
        response.status,
        gqlErrors.map((e) => String(e?.message ?? JSON.stringify(e))).join(', ')
      );
    }
    throw new HttpError(
      'Runpod GraphQL Error',
      response.status,
      bodyText,
      response.status === 429
        ? rateLimitHint(
            response.headers.get('ratelimit'),
            response.headers.get('retry-after')
          )
        : // Only when this request actually carried the caller's API key: the
          // public path sends no Authorization header, so a 401 from that
          // host (WAF, misconfigured RUNPOD_PUBLIC_GRAPHQL_URL) says nothing
          // about the credential — same rationale as observeUnauthorized.
          response.status === 401 && options?.apiKey
          ? EXPIRED_CREDENTIAL_HINT
          : undefined
    );
  }

  const result = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (result.errors && result.errors.length > 0) {
    throw new Error(
      `GraphQL Error: ${result.errors.map((e) => e.message).join(', ')}`
    );
  }

  if (!result.data) {
    throw new Error('No data returned from GraphQL query');
  }

  return result.data;
}

/**
 * Build the shared runtime once per registerTools call. Constructs the
 * caller-tracking closure, the authenticated REST/Serverless/GraphQL clients,
 * and the version-aware backend resolver — all from the live server + context.
 */
export function createToolRuntime(
  server: McpServer,
  ctx: ToolContext,
  deps: ToolDeps = {}
): ToolRuntime {
  const tracking = () => trackingHeaders(server, ctx);

  // Report a 401 once, at the transport boundary, instead of at each of the ~30
  // call sites. Applied to BOTH outbound fetch seams: the JSON clients (REST
  // v1/v2, serverless, GraphQL) and the SSE reader, which binds its own fetch
  // and would otherwise let stream-pod-logs / stream-worker-logs 401s go
  // unreported. Pass-through when no observer is registered (stdio).
  function observeUnauthorized<
    A extends unknown[],
    R extends { status: number },
  >(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    const notify = ctx.onUnauthorized;
    if (!notify) return fn;
    return async (...args: A) => {
      const response = await fn(...args);
      if (response.status === 401) notify();
      return response;
    };
  }

  // Only the AUTHENTICATED seams are observed. The public GraphQL query sends no
  // Authorization header at all, so a 401 from that host (a WAF block, say) says
  // nothing about the caller's credential — observing it would drop a good verdict
  // and force every caller back through the pre-flight.
  const rawFetch = deps.fetch ?? defaultFetch;
  const httpFetch = observeUnauthorized(rawFetch);

  // Deadline policy for all three JSON clients. One budget object shared by all
  // of them, so a handler that crosses clients (get-job-status: serverless, then
  // REST for the diagnosis) draws down a single allowance.
  const remainingHttpBudgetMs = invocationBudget(HTTP_TRANSPORT_BUDGET_MS);
  const timeouts = {
    defaultTimeoutMs: deps.defaultTimeoutMs,
    maxTimeoutMs:
      deps.maxTimeoutMs ??
      (ctx.transport === 'http' ? remainingHttpBudgetMs : undefined),
  };

  // v1 REST client (path-relative to the v1 base).
  const v1Client = createHttpClient({
    apiKey: ctx.apiKey,
    fetch: httpFetch,
    tracking,
    errorPrefix: 'Runpod API Error',
    ...timeouts,
  });
  const runpodRequest = (
    endpoint: string,
    method: string = 'GET',
    body?: Record<string, unknown>,
    options?: RequestOptions
  ) =>
    withApiErrorLog('Error calling Runpod API:', () =>
      v1Client(
        `${restV1Base(process.env as Env)}${endpoint}`,
        method,
        body,
        options
      )
    );

  // Serverless runtime client (endpointId + path against the serverless base).
  const serverlessClient = createHttpClient({
    apiKey: ctx.apiKey,
    fetch: httpFetch,
    tracking,
    errorPrefix: 'Runpod Serverless API Error',
    ...timeouts,
  });
  const serverlessRequest = (
    endpointId: string,
    path: string,
    method: string = 'GET',
    body?: Record<string, unknown>,
    options?: RequestOptions
  ) =>
    withApiErrorLog('Error calling Runpod Serverless API:', () =>
      serverlessClient(
        `${serverlessBase(process.env as Env)}/${endpointId}${path}`,
        method,
        body,
        options
      )
    );

  // v2-aware REST routing (keystone): a full-URL REST client (the adapter
  // resolves base+path per version) used by all adapter-routed resources.
  const restClient = createHttpClient({
    apiKey: ctx.apiKey,
    fetch: httpFetch,
    tracking,
    errorPrefix: 'Runpod API Error',
    ...timeouts,
  });
  const callRestUrl = (
    url: string,
    method: string = 'GET',
    body?: Record<string, unknown>,
    options?: RequestOptions
  ): Promise<unknown> =>
    withApiErrorLog('Error calling Runpod API:', () =>
      restClient(url, method, body, options)
    );

  // Bounded SSE reader for stream-pod-logs / stream-worker-logs. Uses node-fetch
  // directly (not the JSON client) so the response body is read incrementally and
  // stopped on the byte cap or the time bound. The read loop itself lives in
  // logs.ts (readSseSnapshot) so it is unit-testable against a mock Response; here
  // we just bind it to node-fetch + the authenticated headers. Overridable via
  // deps for offline handler tests.
  const sseFetch = observeUnauthorized(
    deps.sseFetch ?? (fetch as unknown as SseFetch)
  );
  const streamSse: StreamSse =
    deps.streamSse ??
    ((url, opts) =>
      readSseSnapshot(
        sseFetch,
        url,
        {
          Authorization: `Bearer ${ctx.apiKey}`,
          Accept: 'text/event-stream',
          ...tracking(),
        },
        opts
      ));

  const backendFor = (resource: Resource): Backend =>
    resolveBackend({
      resource,
      env: process.env as Env,
      ctx: { transport: ctx.transport },
      v2Available: deps.v2Available,
    });

  // B4: pod state transition. v1 has dedicated subpaths (/start, /stop); v2
  // unifies them under POST /pods/{id}/action with an `{action}` body.
  const podAction = async (
    podId: string,
    action: 'start' | 'stop' | 'restart'
  ): Promise<unknown> => {
    const backend = backendFor('pods');
    const podPath = backend.get!(podId);
    if (backend.version === 'v2') {
      return callRestUrl(`${backend.base}${podPath}/action`, 'POST', {
        action,
      });
    }
    return callRestUrl(`${backend.base}${podPath}/${action}`, 'POST');
  };

  return {
    jsonReply,
    // No GraphQL caller overrides a deadline, but both are still capped by the
    // shared budget: deploy-hub-repo spends one of each back to back.
    graphql: <T>(query: string) =>
      graphqlRequest<T>(
        query,
        tracking,
        // rawFetch, not httpFetch: this call carries no credential (see above).
        rawFetch,
        publicGraphqlBase(process.env as Env),
        {
          timeoutMs: deps.defaultTimeoutMs,
          maxTimeoutMs: timeouts.maxTimeoutMs,
        }
      ),
    graphqlAuthed: <T>(query: string, variables?: Record<string, unknown>) =>
      graphqlRequest<T>(
        query,
        tracking,
        httpFetch,
        // NOT publicGraphqlBase: this call carries the caller's API key.
        authedGraphqlBase(process.env as Env),
        {
          variables,
          apiKey: ctx.apiKey,
          timeoutMs: deps.defaultTimeoutMs,
          maxTimeoutMs: timeouts.maxTimeoutMs,
        }
      ),
    runpodRequest,
    serverlessRequest,
    callRestUrl,
    backendFor,
    streamSse,
    podAction,
    env: process.env as Env,
    transport: ctx.transport,
  };
}
