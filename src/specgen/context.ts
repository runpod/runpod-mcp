// The shared context threaded into every curated tool handler: the generated
// SDK client for the v2 management API, plus the clients for the two planes
// the spec does not cover (Serverless runtime, GraphQL) and the bounded SSE
// reader for the log endpoints.
//
// TENANCY: on the hosted (HTTP) path every request builds its own context
// from the caller's bearer token — nothing here may be cached at module
// scope. The stdio path builds one context per process from RUNPOD_API_KEY.

import { createRunpodClient, type RunpodClient } from '@runpod/sdk';
import { createGraphqlClient, type GraphqlClient } from './clients/graphql.js';
import { HttpError } from './clients/http-error.js';
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
}

export function createToolContext(
  options: ToolContextOptions = {}
): ToolContext {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;
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
        if (!apiKey) {
          throw new HttpError(
            'No Runpod API key: the request carried no usable credential.',
            401
          );
        }
        sdk = createRunpodClient({ apiKey });
      }
      return sdk;
    },
    runtime: createRuntimeClient({ apiKey }),
    graphql: createGraphqlClient({ apiKey }),
    sse: createSseReader({ apiKey }),
  };
}
