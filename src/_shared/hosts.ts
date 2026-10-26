// Env-resolved API base URLs, extracted from the retired dual-version backend
// resolver (backend.ts) when the spec-generated surface became the only one.
// The credential preflight compares only active SDK and runtime destinations.

export type Env = Record<string, string | undefined>;

// '' reads as unset everywhere: the wrong-environment guard already strips
// empty vars before comparing, and every consumer (the credential checker's
// probe URL, the GraphQL/log clients) must resolve identically or the
// guard's "checker and guard cannot disagree" invariant breaks.
function pick(value: string | undefined, fallback: string): string {
  return value?.trim().replace(/\/+$/, '') || fallback;
}

// Generated paths include /v2, so the SDK base is the API origin.
export function sdkBase(env: Env): string {
  return pick(env.RUNPOD_API_BASE_URL, 'https://api.runpod.io');
}
export function serverlessBase(env: Env): string {
  return pick(env.RUNPOD_SERVERLESS_API_URL, 'https://api.runpod.ai/v2');
}
export function publicGraphqlBase(env: Env): string {
  return pick(env.RUNPOD_PUBLIC_GRAPHQL_URL, 'https://api.runpod.io/graphql');
}
// A separate var from publicGraphqlBase despite the identical default:
// RUNPOD_PUBLIC_GRAPHQL_URL is the documented credential-free discovery
// override and gets pointed at stubs freely, so routing authed calls through it
// would turn "point this anywhere" into "send the caller's API key there".
export function authedGraphqlBase(env: Env): string {
  return pick(env.RUNPOD_AUTHED_GRAPHQL_URL, 'https://api.runpod.io/graphql');
}
/** The hosted MCP server: install target, and stdio's search-docs backend. */
export function hostedMcpBase(env: Env): string {
  return pick(env.RUNPOD_MCP_URL, 'https://mcp.runpod.io');
}
/** The runpod-assistant Convex site serving /v1/search. No default: unset
 *  means search is not configured. */
export function knowledgeSearchBase(env: Env): string | undefined {
  return pick(env.KNOWLEDGE_SEARCH_URL, '') || undefined;
}
