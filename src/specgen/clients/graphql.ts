// Client for the RunPod GraphQL API, used by the curated tools whose
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

import { HttpError } from './http-error.js';

export const DEFAULT_GRAPHQL_URL = 'https://api.runpod.io/graphql';
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

export function createGraphqlClient(
  options: GraphqlClientOptions = {}
): GraphqlClient {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;
  const publicUrl =
    options.publicUrl ??
    process.env.RUNPOD_PUBLIC_GRAPHQL_URL ??
    DEFAULT_GRAPHQL_URL;
  const authedUrl =
    options.authedUrl ??
    process.env.RUNPOD_AUTHED_GRAPHQL_URL ??
    DEFAULT_GRAPHQL_URL;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(
    url: string,
    query: string,
    variables?: Record<string, unknown>,
    bearer?: string
  ): Promise<T> {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpError(
        `Runpod GraphQL HTTP error (${response.status})`,
        response.status,
        body
      );
    }

    const result = (await response.json()) as {
      data?: T;
      errors?: Array<{ message: string }>;
    };
    if (result.errors && result.errors.length > 0) {
      throw new HttpError(
        `GraphQL error: ${result.errors.map((e) => e.message).join(', ')}`,
        response.status,
        result.errors
      );
    }
    if (result.data === undefined || result.data === null) {
      throw new HttpError('GraphQL response carried no data', response.status);
    }
    return result.data;
  }

  return {
    public: (query) => request(publicUrl, query),
    authed: (query, variables) => request(authedUrl, query, variables, apiKey),
  };
}
