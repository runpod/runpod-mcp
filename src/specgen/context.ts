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
}

export interface ToolContextOptions {
  /** Per-caller credential. Falls back to RUNPOD_API_KEY (stdio path). */
  apiKey?: string;
  /** Team the caller acts for (hosted: the inbound X-Team-Id header). */
  teamId?: string;
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

// The REST v2 URL prefix, normalized the way `new Request` normalizes
// request.url (lowercase host, default port dropped), so a base like
// https://API.RUNPOD.IO:443 still matches and REST calls do not silently lose
// the team. A base that does not parse keeps the raw string: building the
// context must not throw, and the SDK call reports the bad base itself.
function restV2PrefixOf(base: string): string {
  try {
    const url = new URL(base);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/v2/`;
  } catch {
    return `${base}/v2/`;
  }
}

export function createToolContext(
  options: ToolContextOptions = {}
): ToolContext {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;

  // One wrapped fetch shared by all four clients. It adds two kinds of
  // header, each only where the request does not already set it:
  //  - tracking (User-Agent + X-Runpod-Session-Id) identifies the calling MCP
  //    client on every outbound API request; the session id is per-context —
  //    per-request on hosted, per-process on stdio.
  //  - X-Team-Id scopes a Console (Clerk JWT) call to a team, on REST v2
  //    requests only (spec securitySchemes.bearerAuth). GraphQL (public and
  //    authed, same origin as REST but not under /v2/) and the Serverless
  //    runtime host do not document the header, so they never receive it.
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
  const restV2Prefix = teamId ? restV2PrefixOf(sdkBase(process.env)) : '';
  let fetchImpl: typeof fetch = fetch;
  if (options.tracking || teamId) {
    fetchImpl = (input, init) => {
      // openapi-fetch calls fetch with a fully-built Request as `input`
      // (headers inside it, no init); other clients pass (url, init). Fold
      // both into one Request, then add headers only where absent — passing
      // a headers init alongside a Request would REPLACE the request's own
      // headers and drop Authorization.
      const request = new Request(input, init);
      for (const [name, value] of Object.entries(trackingHeaders)) {
        if (!request.headers.has(name)) request.headers.set(name, value);
      }
      if (
        teamId &&
        request.url.startsWith(restV2Prefix) &&
        !request.headers.has('X-Team-Id')
      ) {
        request.headers.set('X-Team-Id', teamId);
      }
      return fetch(request);
    };
  }

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
          fetch: fetchImpl,
          timeoutMs: options.sdkTimeoutMs ?? SDK_TIMEOUT_MS,
          retry: options.sdkRetry ?? SDK_RETRY,
        });
      }
      return sdk;
    },
    runtime: createRuntimeClient({ apiKey, fetchImpl }),
    graphql: createGraphqlClient({ apiKey, fetchImpl }),
    sse: createSseReader({ apiKey, fetchImpl }),
  };
}
