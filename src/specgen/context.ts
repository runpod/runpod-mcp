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
} from '@runpod/sdk';
import { buildTrackingHeaders } from '../_shared/tracking.js';
import { createGraphqlClient, type GraphqlClient } from './clients/graphql.js';
import { boundedFetch } from './clients/bounded-fetch.js';
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
}

export interface ToolContextOptions {
  /** Per-caller credential. Falls back to RUNPOD_API_KEY (stdio path). */
  apiKey?: string;
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

export function createToolContext(
  options: ToolContextOptions = {}
): ToolContext {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;

  // One wrapped fetch shared by all four clients: identifies the calling MCP
  // client on every outbound API request. The session id is per-context —
  // per-request on hosted, per-process on stdio.
  let fetchImpl: typeof fetch = fetch;
  if (options.tracking) {
    const headers = buildTrackingHeaders({
      ...options.tracking,
      sessionId: randomUUID(),
    });
    fetchImpl = (input, init) => {
      // openapi-fetch calls fetch with a fully-built Request as `input`
      // (headers inside it, no init); other clients pass (url, init). Fold
      // both into one Request, then add the tracking headers only where
      // absent — passing a headers init alongside a Request would REPLACE
      // the request's own headers and drop Authorization.
      const request = new Request(input, init);
      for (const [name, value] of Object.entries(headers)) {
        if (!request.headers.has(name)) request.headers.set(name, value);
      }
      return fetch(request);
    };
  }

  // SDK-only fetch: fetchImpl plus the request deadline. openapi-fetch never
  // sets a signal of its own, so the timeout is authoritative here.
  const sdkFetch = boundedFetch(
    fetchImpl,
    options.sdkTimeoutMs ?? SDK_TIMEOUT_MS
  );

  let sdk: RunpodClient | undefined;

  return {
    apiKey,
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
          fetch: sdkFetch,
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
