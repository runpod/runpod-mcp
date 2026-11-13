// The shared context threaded into every curated tool handler: the generated
// SDK client for the v2 management API, plus the clients for the two planes
// the spec does not cover (Serverless runtime, GraphQL) and the bounded SSE
// reader for the log endpoints.
//
// TENANCY: on the hosted (HTTP) path every request builds its own context
// from the caller's bearer token — nothing here may be cached at module
// scope. The stdio path builds one context per process from RUNPOD_API_KEY.

import { randomUUID } from 'node:crypto';
import {
  createRunpodClient,
  type RetryOptions,
  type RunpodClient,
} from '@runpod/typescript-api-sdk';
import { sdkBase } from '../_shared/hosts.js';
import { buildTrackingHeaders } from '../_shared/tracking.js';
import { createGraphqlClient, type GraphqlClient } from './clients/graphql.js';
import { missingKeyError } from './clients/http-error.js';
import { createRuntimeClient, type RuntimeClient } from './clients/runtime.js';
import { createSseReader, type SseReader } from './clients/sse.js';

export interface ToolContext {
  sdk: RunpodClient;
  runtime: RuntimeClient;
  graphql: GraphqlClient;
  sse: SseReader;
  /** The key this context authenticates with (hosted: the caller's bearer token). */
  apiKey: string | undefined;
  /** Late-bind the calling client's identity into the tracking User-Agent.
   *  The stdio transport only learns it from the MCP initialize handshake,
   *  which happens after this context is built. No-op without tracking. */
  setClientInfo?: (name: string, version?: string) => void;
  /** Team the caller acts for (hosted: the inbound X-Team-Id header). Tools
   *  that cannot carry it (non-REST-v2 writes) refuse when it is set. */
  teamId?: string;
}

export interface ToolContextOptions {
  /** Per-caller credential. Falls back to RUNPOD_API_KEY (stdio path). */
  apiKey?: string;
  /** Team the caller acts for (hosted: the inbound X-Team-Id header). */
  teamId?: string;
  /** Caller's request trace id (hosted: the inbound X-Trace-ID header). */
  traceId?: string;
  /** Caller identity stamped on every outbound API call (User-Agent +
   *  X-Runpod-Session-Id). Ported from the pre-specgen server. */
  tracking?: {
    clientName?: string;
    clientVersion?: string;
    transport: 'stdio' | 'http';
    serverVersion: string;
  };
  /** Test seam: deadline for one SDK (generated-tool) request. */
  sdkTimeoutMs?: number;
  /** Test seam: SDK retry tuning (false disables the retry layer). */
  sdkRetry?: RetryOptions | false;
}

// Deadline for one SDK request. The generated tools are plain CRUD calls —
// nothing on that surface legitimately takes longer, and without a signal a
// host that accepts the connection then goes silent parks the invocation
// until the platform reaper (the leak PR #83 fixed on the old surface). The
// long-hold paths (job waits, SSE streams) do NOT go through the SDK; their
// clients carry their own bounded signals.
const SDK_TIMEOUT_MS = 30_000;

// Bound the SDK's retry layer: its defaults honor Retry-After up to 60s per
// sleep across 4 attempts, which alone can outlive the hosted invocation's
// 45s budget. Retries here are for transient blips only — a real 429 must
// come back to the agent quickly, carrying the header-derived wait hint, so
// the AGENT decides how long to pause (dispatch enriches it; a server-side
// sleep would just burn the budget silently).
const SDK_RETRY: RetryOptions = {
  maxAttempts: 3,
  maxBackoffMs: 2_000,
  maxRetryAfterMs: 5_000,
};

// A fetch that adds `headers()` to each request where the request does not
// already set the header. Returns the bare global fetch when `active` is false,
// so stdio without tracking or a team behaves exactly as before.
function withHeaders(
  headers: () => Record<string, string>,
  active: boolean
): typeof fetch {
  if (!active) return fetch;
  return (input, init) => {
    // openapi-fetch calls fetch with a fully-built Request as `input`
    // (headers inside it, no init); other clients pass (url, init). Fold both
    // into one Request, then add headers only where absent — passing a headers
    // init alongside a Request would REPLACE the request's own headers and drop
    // Authorization.
    const request = new Request(input, init);
    for (const [name, value] of Object.entries(headers())) {
      if (!request.headers.has(name)) request.headers.set(name, value);
    }
    return fetch(request);
  };
}

export function createToolContext(
  options: ToolContextOptions = {}
): ToolContext {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;

  // Outbound headers, each added only where the request does not set it:
  //  - tracking (User-Agent + X-Runpod-Session-Id) identifies the calling MCP
  //    client on every outbound API request; the session id is per-context —
  //    per-request on hosted, per-process on stdio.
  //  - X-Team-Id scopes a Console (Clerk JWT) call to a team. Only REST v2
  //    documents it (spec securitySchemes.bearerAuth), so only the clients that
  //    call REST v2 (`sdk`, and `sse` for the /v2 log streams) get it. The
  //    Serverless runtime and GraphQL never do, whatever their hosts are.
  //  - X-Trace-ID joins a REST v2 call to the caller's request in the API
  //    request log. REST v2 forwards it to GraphQL itself, so the same REST v2
  //    clients are the only ones that send it.
  let trackingHeaders: Record<string, string> = {};
  let setClientInfo: ToolContext['setClientInfo'];
  if (options.tracking) {
    // Mutable so the stdio handshake can late-bind clientInfo; headers are
    // rebuilt only when it changes.
    const tracking = { ...options.tracking, sessionId: randomUUID() };
    trackingHeaders = buildTrackingHeaders(tracking);
    setClientInfo = (name, version) => {
      tracking.clientName = name;
      tracking.clientVersion = version;
      trackingHeaders = buildTrackingHeaders(tracking);
    };
  }
  const teamId = options.teamId;
  const trackingFetch = withHeaders(() => trackingHeaders, !!options.tracking);
  const traceId = options.traceId;
  const restFetch = withHeaders(
    () => ({
      ...trackingHeaders,
      ...(teamId ? { 'X-Team-Id': teamId } : {}),
      ...(traceId ? { 'X-Trace-ID': traceId } : {}),
    }),
    !!options.tracking || !!teamId || !!traceId
  );

  let sdk: RunpodClient | undefined;

  return {
    apiKey,
    setClientInfo,
    // Built on first use, not at startup. The SDK client constructor throws
    // when no API key is present, and the MCP handshake plus tools/list are a
    // credential-free surface — a client must be able to start the server and
    // read its tool list without a key. A key-less call then fails as a 401
    // tool result instead of killing the process.
    get sdk(): RunpodClient {
      if (!sdk) {
        if (!apiKey) throw missingKeyError();
        sdk = createRunpodClient({
          apiKey,
          baseUrl: sdkBase(process.env),
          fetch: restFetch,
          timeoutMs: options.sdkTimeoutMs ?? SDK_TIMEOUT_MS,
          retry: options.sdkRetry ?? SDK_RETRY,
        });
      }
      return sdk;
    },
    teamId,
    runtime: createRuntimeClient({ apiKey, fetchImpl: trackingFetch }),
    graphql: createGraphqlClient({ apiKey, fetchImpl: trackingFetch }),
    sse: createSseReader({ apiKey, fetchImpl: restFetch }),
  };
}
