// Client for the Runpod GraphQL API, used by the curated tools whose
// capability has no REST v2 home yet (Hub, capacity matrix, public endpoints,
// endpoint GPU pinning). Two deliberately separate seams, mirroring the
// official MCP server:
//
// - public: credential-free discovery queries (the server answers them
//   unauthenticated). Host from RUNPOD_PUBLIC_GRAPHQL_URL.
// - authed: the caller's API key as a Bearer token (the GraphQL gateway
//   accepts the same key REST uses). Host from RUNPOD_AUTHED_GRAPHQL_URL.
//
// Separate env vars despite the identical default, so the credential-free
// path can be pointed at a stub without the key following it.

import { withRateLimitHint } from '../../_shared/rate-limit.js';
import { authedGraphqlBase, publicGraphqlBase } from '../../_shared/hosts.js';
import { boundedFetch } from './bounded-fetch.js';
import { HttpError, missingKeyError } from './http-error.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface GraphqlClient {
  public<T>(query: string): Promise<T>;
  authed<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

export interface GraphqlClientOptions {
  apiKey?: string;
  publicUrl?: string;
  authedUrl?: string;
  fetchImpl?: typeof fetch;
}

// Status for a GraphQL error delivered on a 2xx. Only the authed path sends a
// key, and an invalid key is rejected at the gateway with a real 401, so a
// field-level UNAUTHORIZED means the key was accepted but may not do this:
// a permission problem (403), not a dead credential.
function graphqlErrorStatus(code: unknown): number {
  switch (code) {
    case 'UNAUTHENTICATED':
      return 401;
    case 'UNAUTHORIZED':
    case 'FORBIDDEN':
      return 403;
    // Runpod's own code for a rejected request: an unknown GPU pool, a missing
    // template, no balance. The caller has to change the input, so it is a 400
    // and gets the 400 detail hints, not a retry-the-same-call 502.
    case 'RUNPOD':
    case 'BAD_USER_INPUT':
    case 'GRAPHQL_VALIDATION_FAILED':
    case 'GRAPHQL_PARSE_FAILED':
      return 400;
    default:
      return 502;
  }
}

export function createGraphqlClient(
  options: GraphqlClientOptions = {}
): GraphqlClient {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;
  // Resolved through _shared/hosts.ts so '' reads as unset here exactly like
  // it does in the hosted wrong-environment guard.
  const publicUrl = options.publicUrl ?? publicGraphqlBase(process.env);
  const authedUrl = options.authedUrl ?? authedGraphqlBase(process.env);
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    url: string,
    query: string,
    variables?: Record<string, unknown>,
    bearer?: string
  ): Promise<T> {
    const response = await boundedFetch(fetchImpl, DEFAULT_TIMEOUT_MS)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpError(
        `Runpod GraphQL HTTP error (${response.status})`,
        response.status,
        response.status === 429
          ? withRateLimitHint({ error: body }, response.headers)
          : body
      );
    }

    const result = (await response.json()) as {
      data?: T;
      errors?: unknown;
    };
    // Runpod answers resolver failures with HTTP 200 and an errors array
    // (an unauthenticated field reads `extensions.code: "UNAUTHORIZED"`), so
    // the failure status comes from the error, never the 200: a failed call
    // reported as 200 gets no recovery hint and is logged as a 200.
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      const errors = result.errors as Array<{
        message?: unknown;
        extensions?: { code?: unknown };
      }>;
      throw new HttpError(
        `GraphQL error: ${errors.map((e) => String(e?.message ?? JSON.stringify(e))).join(', ')}`,
        graphqlErrorStatus(errors[0]?.extensions?.code),
        errors
      );
    }
    if (result.data === undefined || result.data === null) {
      throw new HttpError(
        'GraphQL response carried no data',
        502,
        result.errors
      );
    }
    return result.data;
  }

  return {
    public: (query) => request(publicUrl, query),
    authed: async (query, variables) => {
      // A key-less authed call must 401 up front, not go out unauthenticated
      // and come back as an opaque gateway error that never trips
      // onUnauthorized. async so the 401 is a rejection, matching the
      // Promise-returning signature (a sync throw escapes Promise.race/
      // fire-then-await callers).
      if (!apiKey) throw missingKeyError();
      return request(authedUrl, query, variables, apiKey);
    },
  };
}
