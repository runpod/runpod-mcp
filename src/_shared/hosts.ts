// Env-resolved API base URLs, extracted from the retired dual-version backend
// resolver (backend.ts) when the spec-generated surface became the only one.
// The credential pre-flight's wrong-environment guard (src/http.ts) still
// compares these to their defaults, so they live on independently of any tool.

export type Env = Record<string, string | undefined>;

export function restV1Base(env: Env): string {
  return env.RUNPOD_REST_API_URL ?? 'https://rest.runpod.io/v1';
}
export function restV2Base(env: Env): string {
  return env.RUNPOD_REST_V2_API_URL ?? 'https://api.runpod.io/v2';
}
export function serverlessBase(env: Env): string {
  return env.RUNPOD_SERVERLESS_API_URL ?? 'https://api.runpod.ai/v2';
}
export function publicGraphqlBase(env: Env): string {
  return env.RUNPOD_PUBLIC_GRAPHQL_URL ?? 'https://api.runpod.io/graphql';
}
// A separate var from publicGraphqlBase despite the identical default:
// RUNPOD_PUBLIC_GRAPHQL_URL is the documented credential-free discovery
// override and gets pointed at stubs freely, so routing authed calls through it
// would turn "point this anywhere" into "send the caller's API key there".
export function authedGraphqlBase(env: Env): string {
  return env.RUNPOD_AUTHED_GRAPHQL_URL ?? 'https://api.runpod.io/graphql';
}
