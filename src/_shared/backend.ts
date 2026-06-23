// ============== BACKEND ADAPTER (v1/v2 routing core) ==============
// Pure routing layer that lets tools stay version-agnostic. A tool asks for a
// resource backend; the adapter decides v1 vs v2, resolves the base URL + path,
// normalizes the list response shape (`unwrapList`), and maps request bodies.
//
// This module is intentionally pure and side-effect free: env, transport, and
// the v2 probe are all passed in, so every function is unit-testable offline
// with no network and no MCP SDK. The HTTP client (src/_shared/http.ts) and the
// per-resource tool handlers (src/tools/<resource>.ts) consume this.

// One canonical resource union used by unwrapList, resolveVersion, and
// resolveBackend alike — so the steps don't each invent a spelling. The v2
// list-envelope key happens to equal the resource name.
export type Resource =
  | 'pods'
  | 'templates'
  | 'networkVolumes'
  | 'registries'
  | 'gpus'
  | 'cpus'
  | 'dataCenters'
  | 'endpoints'
  | 'jobs';

export type RestVersion = 'v1' | 'v2';

// Resources that have no v2 REST home and stay on v1 regardless of any flag.
// - jobs: serverless runtime, lives on api.runpod.ai/v2 (a different service)
// - endpoints: endpoint CRUD, REST base — v2 has no /v2/endpoints yet
const V1_ONLY: ReadonlySet<Resource> = new Set<Resource>(['jobs', 'endpoints']);

// The key each v2 list response is wrapped in: `{ pods: [...] }`, etc.
const V2_UNWRAP_KEY: Record<Resource, string> = {
  pods: 'pods',
  templates: 'templates',
  networkVolumes: 'networkVolumes',
  registries: 'registries',
  gpus: 'gpus',
  cpus: 'cpus',
  dataCenters: 'dataCenters',
  endpoints: 'endpoints',
  jobs: 'jobs',
};

// Env-var suffix for the per-resource version override (RUNPOD_REST_VERSION_<KEY>).
const RESOURCE_ENV_KEY: Record<Resource, string> = {
  pods: 'PODS',
  templates: 'TEMPLATES',
  networkVolumes: 'NETWORK_VOLUMES',
  registries: 'REGISTRIES',
  gpus: 'GPUS',
  cpus: 'CPUS',
  dataCenters: 'DATA_CENTERS',
  endpoints: 'ENDPOINTS',
  jobs: 'JOBS',
};

// ---- Base URLs (resolved from env, with the same defaults tools.ts uses) ----

export type Env = Record<string, string | undefined>;

export function restV1Base(env: Env): string {
  return env.RUNPOD_REST_API_URL ?? 'https://rest.runpod.io/v1';
}
export function restV2Base(env: Env): string {
  return env.RUNPOD_REST_V2_API_URL ?? 'https://v2-rest.runpod.io/v2';
}
export function serverlessBase(env: Env): string {
  return env.RUNPOD_SERVERLESS_API_URL ?? 'https://api.runpod.ai/v2';
}

// ---- A0: unwrap a list response into a plain array ----
// v1 returns a bare array; v2 wraps it in a per-resource envelope. Either way
// we hand `capListResult` a plain array. Anything unexpected → [] (never throws
// in an agent's face, and never passes a non-array through to the cap).
export function unwrapList(
  resource: Resource,
  version: RestVersion,
  raw: unknown
): unknown[] {
  if (version === 'v1') return Array.isArray(raw) ? raw : [];
  if (raw === null || typeof raw !== 'object') return [];
  const arr = (raw as Record<string, unknown>)[V2_UNWRAP_KEY[resource]];
  return Array.isArray(arr) ? arr : [];
}

// ---- A1: resolve which version a given resource call should use ----
// Pure: env, transport, and the already-resolved v2 probe verdict are injected.
// Precedence: v1-only resources → v1; else RUNPOD_REST_VERSION_<RESOURCE> →
// RUNPOD_REST_VERSION → default 'v1'. `auto` probes only on stdio (one process =
// one key); on hosted HTTP `auto` is treated as v1 (a warm instance serves many
// keys, so a cached probe verdict would leak across users).
//
// `v2Available` is a *resolved boolean*, NOT a thunk or a promise: the caller
// awaits createV2Prober() once at startup (stdio only) and passes the boolean
// in. This is deliberate — a `() => Promise<boolean>` would be truthy even when
// the probe failed, silently forcing v2. Keeping it a plain boolean removes that
// footgun. When omitted under `auto`, we conservatively resolve to v1.
export interface VersionCtx {
  transport: 'stdio' | 'http';
}

export function resolveVersion(opts: {
  resource: Resource;
  env: Env;
  ctx: VersionCtx;
  v2Available?: boolean;
}): RestVersion {
  const { resource, env, ctx, v2Available } = opts;
  if (V1_ONLY.has(resource)) return 'v1';

  const perResource = env[`RUNPOD_REST_VERSION_${RESOURCE_ENV_KEY[resource]}`];
  const setting = (
    perResource ??
    env.RUNPOD_REST_VERSION ??
    'v1'
  ).toLowerCase();

  if (setting === 'v2') return 'v2';
  if (setting === 'auto') {
    if (ctx.transport === 'http') return 'v1';
    return v2Available === true ? 'v2' : 'v1';
  }
  return 'v1';
}

// ---- A1b: the real `auto` probe (decision logic, injected fetch) ----
// Returns an async resolver that probes once and memoizes the verdict for the
// process. The startup wiring (stdio only) awaits this once, then passes the
// resulting boolean to resolveVersion as `v2Available`. Never wire into the HTTP
// path (see resolveVersion).
//
// Only *definitive* verdicts are cached: a reachable endpoint (any non-5xx
// response) pins true/false, but a transient failure (thrown error or 5xx) is
// NOT cached — it returns false for this call and re-probes next time, so a
// one-time startup network blip doesn't pin the process to v1 forever.
type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> }
) => Promise<{ status: number }>;

export function createV2Prober(deps: {
  fetch: FetchLike;
  baseUrl: string;
  apiKey: string;
}): () => Promise<boolean> {
  let cached: boolean | undefined;
  let inFlight: Promise<boolean> | undefined;

  return function probeV2(): Promise<boolean> {
    if (cached !== undefined) return Promise.resolve(cached);
    // Coalesce concurrent first-calls onto one in-flight probe.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const res = await deps.fetch(`${deps.baseUrl}/catalog/gpus`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${deps.apiKey}` },
        });
        if (res.status >= 500) return false; // transient — do not cache
        cached = res.status >= 200 && res.status < 300;
        return cached;
      } catch {
        return false; // transient — do not cache
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };
}

// ---- A2: resolve the backend descriptor for a resource ----
// `kind` distinguishes a normal REST resource from the GraphQL-backed catalog
// (v1) and the serverless-runtime jobs base. mapCreate/mapUpdate default to
// identity under v1; Phase B fills the v2 half (paths + body mappers + unwrap).
export type BackendKind = 'rest' | 'graphql';

export interface Backend {
  kind: BackendKind;
  version: RestVersion;
  base: string;
  list?: string;
  get?: (id: string) => string;
  unwrap: (raw: unknown) => unknown[];
  mapCreate: (body: unknown) => unknown;
  mapUpdate: (body: unknown) => unknown;
}

const identity = (body: unknown): unknown => body;

// v1 REST paths, exactly as tools.ts uses them today.
const V1_REST_PATHS: Partial<
  Record<Resource, { list: string; get: (id: string) => string }>
> = {
  pods: { list: '/pods', get: (id) => `/pods/${id}` },
  templates: { list: '/templates', get: (id) => `/templates/${id}` },
  networkVolumes: {
    list: '/networkvolumes',
    get: (id) => `/networkvolumes/${id}`,
  },
  registries: {
    list: '/containerregistryauth',
    get: (id) => `/containerregistryauth/${id}`,
  },
  endpoints: { list: '/endpoints', get: (id) => `/endpoints/${id}` },
};

const CATALOG: ReadonlySet<Resource> = new Set<Resource>([
  'gpus',
  'cpus',
  'dataCenters',
]);

export function resolveBackend(opts: {
  resource: Resource;
  env: Env;
  ctx: VersionCtx;
  v2Available?: boolean;
}): Backend {
  const { resource, env } = opts;
  const version = resolveVersion(opts);
  const unwrap = (raw: unknown): unknown[] =>
    unwrapList(resource, version, raw);

  if (version === 'v2') {
    // Filled in Phase B (B2/B1/B3/B5). Throwing here keeps the v1-only Phase A
    // honest: nothing routes to v2 until the mappers + paths exist.
    throw new Error(
      `v2 backend for "${resource}" not implemented until Phase B`
    );
  }

  // ---- v1 ----
  if (resource === 'jobs') {
    return {
      kind: 'rest',
      version,
      base: serverlessBase(env),
      unwrap,
      mapCreate: identity,
      mapUpdate: identity,
    };
  }
  if (CATALOG.has(resource)) {
    // v1 catalog is GraphQL via a separate helper (kept out of the unified REST
    // client through Phase A); folds into REST at Step B5.
    return {
      kind: 'graphql',
      version,
      base: env.RUNPOD_PUBLIC_GRAPHQL_URL ?? 'https://api.runpod.io/graphql',
      unwrap,
      mapCreate: identity,
      mapUpdate: identity,
    };
  }

  const paths = V1_REST_PATHS[resource];
  if (!paths) {
    throw new Error(`no v1 REST paths for resource "${resource}"`);
  }
  return {
    kind: 'rest',
    version,
    base: restV1Base(env),
    list: paths.list,
    get: paths.get,
    unwrap,
    mapCreate: identity,
    mapUpdate: identity,
  };
}
