import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';
import { createHttpClient, HttpError } from '../_shared/http.js';
import { buildTrackingHeaders } from '../_shared/tracking.js';
import {
  resolveBackend,
  restV1Base,
  serverlessBase,
  publicGraphqlBase,
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
// module reload. The defaults live in _shared/backend.ts. The public GraphQL
// endpoint is distinct from the flash auth backend (RUNPOD_GRAPHQL_URL, used
// only by the OAuth flow in api/index.ts).

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
  // Authenticated v1 REST call, path-relative to the v1 base (e.g. `/endpoints`).
  runpodRequest: (
    endpoint: string,
    method?: string,
    body?: Record<string, unknown>
  ) => Promise<unknown>;
  // Authenticated Serverless runtime call (api.runpod.ai/v2/{endpointId}{path}).
  serverlessRequest: (
    endpointId: string,
    path: string,
    method?: string,
    body?: Record<string, unknown>
  ) => Promise<unknown>;
  // Authenticated REST call to a fully-resolved URL (the adapter builds the URL).
  callRestUrl: (
    url: string,
    method?: string,
    body?: Record<string, unknown>
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
  url: string
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...tracking(),
    },
    body: JSON.stringify({ query }),
  });

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
  const httpFetch = deps.fetch ?? defaultFetch;

  // v1 REST client (path-relative to the v1 base).
  const v1Client = createHttpClient({
    apiKey: ctx.apiKey,
    fetch: httpFetch,
    tracking,
    errorPrefix: 'Runpod API Error',
  });
  const runpodRequest = (
    endpoint: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ) =>
    withApiErrorLog('Error calling Runpod API:', () =>
      v1Client(`${restV1Base(process.env as Env)}${endpoint}`, method, body)
    );

  // Serverless runtime client (endpointId + path against the serverless base).
  const serverlessClient = createHttpClient({
    apiKey: ctx.apiKey,
    fetch: httpFetch,
    tracking,
    errorPrefix: 'Runpod Serverless API Error',
  });
  const serverlessRequest = (
    endpointId: string,
    path: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ) =>
    withApiErrorLog('Error calling Runpod Serverless API:', () =>
      serverlessClient(
        `${serverlessBase(process.env as Env)}/${endpointId}${path}`,
        method,
        body
      )
    );

  // v2-aware REST routing (keystone): a full-URL REST client (the adapter
  // resolves base+path per version) used by all adapter-routed resources.
  const restClient = createHttpClient({
    apiKey: ctx.apiKey,
    fetch: httpFetch,
    tracking,
    errorPrefix: 'Runpod API Error',
  });
  const callRestUrl = (
    url: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ): Promise<unknown> =>
    withApiErrorLog('Error calling Runpod API:', () =>
      restClient(url, method, body)
    );

  // Bounded SSE reader for stream-pod-logs. Uses node-fetch directly (not the
  // JSON client) so we can read the response body incrementally and stop on the
  // byte cap or the time bound. The log stream stays open to tail live output,
  // so a timeout-abort is a NORMAL end (return what we collected), not an error;
  // only a non-OK HTTP status throws. Overridable via deps for offline tests.
  const streamSse: StreamSse =
    deps.streamSse ??
    (async (url, opts) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.maxWaitMs);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${ctx.apiKey}`,
            Accept: 'text/event-stream',
            ...tracking(),
          },
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new HttpError(
            'Runpod API Error',
            res.status,
            await res.text().catch(() => '')
          );
        }
        // Collect raw Buffers and decode ONCE at the end: avoids both a UTF-8
        // char being split across two network chunks (per-chunk toString would
        // corrupt it) and the O(n²) cost of re-measuring a growing string.
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        try {
          for await (const chunk of res.body as AsyncIterable<Buffer>) {
            chunks.push(chunk);
            bytes += chunk.length;
            if (bytes >= opts.maxBytes) {
              truncated = true;
              controller.abort();
              break;
            }
          }
        } catch (err) {
          // AbortError (timeout or byte-cap abort) is the expected stream end —
          // keep what we read. Anything else propagates.
          if (!(err instanceof Error && err.name === 'AbortError')) throw err;
        }
        return { raw: Buffer.concat(chunks).toString('utf8'), truncated };
      } finally {
        clearTimeout(timer);
      }
    });

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
    graphql: <T>(query: string) =>
      graphqlRequest<T>(
        query,
        tracking,
        httpFetch,
        publicGraphqlBase(process.env as Env)
      ),
    runpodRequest,
    serverlessRequest,
    callRestUrl,
    backendFor,
    streamSse,
    podAction,
    env: process.env as Env,
  };
}
