import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';
import { capListResult, listPaginationParams } from './pagination.js';
import { createHttpClient, HttpError } from './_shared/http.js';
import { buildTrackingHeaders } from './_shared/tracking.js';
import { resolveBackend, type Env, type Backend } from './_shared/backend.js';

// Base URL for Runpod REST API. Override via RUNPOD_REST_API_URL to point at a
// non-production environment (e.g. when authenticating with a dev API key).
const API_BASE_URL =
  process.env.RUNPOD_REST_API_URL ?? 'https://rest.runpod.io/v1';

// Serverless API base URL for endpoint runtime operations (run, status, cancel, etc.).
// Override via RUNPOD_SERVERLESS_API_URL for non-production environments.
const SERVERLESS_API_BASE_URL =
  process.env.RUNPOD_SERVERLESS_API_URL ?? 'https://api.runpod.ai/v2';

// GraphQL endpoint for public queries (GPU types, data centers). Override via
// RUNPOD_PUBLIC_GRAPHQL_URL for non-production environments. This is distinct
// from the flash auth backend (RUNPOD_GRAPHQL_URL, used only by the OAuth flow
// in api/index.ts).
const GRAPHQL_URL =
  process.env.RUNPOD_PUBLIC_GRAPHQL_URL ?? 'https://api.runpod.io/graphql';

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

// Helper function to make GraphQL requests to Runpod (public, no auth required)
async function graphqlRequest<T>(
  query: string,
  tracking: () => Record<string, string>
): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
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

// Helper function to make authenticated API requests to Runpod REST API
// The REST + Serverless request helpers now delegate to the unified
// `createHttpClient` (src/_shared/http.ts). The adapter builds the full URL, so
// these thin wrappers just preserve the existing call signatures (path-relative
// for REST, `endpointId`+path for serverless) and the existing `console.error`
// log + re-throw behavior. The unified client throws `HttpError` (a subclass of
// Error) with the SAME message string as before, so callers that read
// `error.message` (e.g. stream-job) are unaffected.

// The fetch implementation the unified client uses. Defaults to node-fetch;
// tests inject a fake to capture outbound requests offline (the A4 seam).
type HttpFetch = Parameters<typeof createHttpClient>[0]['fetch'];
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
// Every tool returns this shape, so it lives at module scope.
function jsonReply(result: unknown) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(result, null, 2) },
    ],
  };
}

function createRunpodRequest(
  apiKey: string,
  tracking: () => Record<string, string>,
  httpFetch: HttpFetch = defaultFetch
) {
  const client = createHttpClient({
    apiKey,
    fetch: httpFetch,
    tracking,
    errorPrefix: 'Runpod API Error',
  });
  return (
    endpoint: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ) =>
    withApiErrorLog('Error calling Runpod API:', () =>
      client(`${API_BASE_URL}${endpoint}`, method, body)
    );
}

// Helper function to make authenticated requests to the Serverless runtime API
function createServerlessRequest(
  apiKey: string,
  tracking: () => Record<string, string>,
  httpFetch: HttpFetch = defaultFetch
) {
  const client = createHttpClient({
    apiKey,
    fetch: httpFetch,
    tracking,
    errorPrefix: 'Runpod Serverless API Error',
  });
  return (
    endpointId: string,
    path: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ) =>
    withApiErrorLog('Error calling Runpod Serverless API:', () =>
      client(`${SERVERLESS_API_BASE_URL}/${endpointId}${path}`, method, body)
    );
}

/**
 * Register all Runpod tools on the given MCP server instance. The provided
 * context supplies the API key that authenticated request helpers will use.
 */
export function registerTools(
  server: McpServer,
  ctx: ToolContext,
  // Optional test seam: inject a fake fetch to capture outbound requests
  // offline. Production passes nothing → node-fetch. `v2Available` is the
  // already-resolved stdio `auto`-probe verdict (see backend.resolveVersion);
  // omitted → `auto` resolves to v1.
  deps: { fetch?: HttpFetch; v2Available?: boolean } = {}
): void {
  const tracking = () => trackingHeaders(server, ctx);
  const httpFetch = deps.fetch ?? defaultFetch;
  const runpodRequest = createRunpodRequest(ctx.apiKey, tracking, httpFetch);
  const serverlessRequest = createServerlessRequest(
    ctx.apiKey,
    tracking,
    httpFetch
  );

  // ---- v2-aware REST routing (keystone) ----
  // A full-URL REST client (the adapter resolves base+path per version) +
  // helpers to resolve a resource's backend and format the standard JSON reply.
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
  const backendFor = (
    resource: Parameters<typeof resolveBackend>[0]['resource']
  ): Backend =>
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

  // ============== INFRASTRUCTURE TOOLS ==============

  // List GPU Types
  server.tool(
    'list-gpu-types',
    {
      minMemoryGb: z
        .number()
        .optional()
        .describe('Filter to GPUs with at least this much VRAM in GB'),
      secureCloudOnly: z
        .boolean()
        .optional()
        .describe('Filter to only GPUs available in secure cloud'),
      communityCloudOnly: z
        .boolean()
        .optional()
        .describe('Filter to only GPUs available in community cloud'),
      searchTerm: z
        .string()
        .optional()
        .describe(
          "Search term to filter GPUs by name (e.g., 'A100', 'RTX 4090')"
        ),
      includeUnavailable: z
        .boolean()
        .optional()
        .describe(
          'Include GPUs that are currently out of stock. Default is false'
        ),
    },
    async (params) => {
      interface GpuTypesResponse {
        gpuTypes: Array<{
          id: string;
          displayName: string;
          memoryInGb: number;
          secureCloud: boolean;
          communityCloud: boolean;
          lowestPrice?: { stockStatus: string | null } | null;
        }>;
      }

      const data = await graphqlRequest<GpuTypesResponse>(
        `
        query {
          gpuTypes {
            id
            displayName
            memoryInGb
            secureCloud
            communityCloud
            lowestPrice(input: { gpuCount: 1 }) {
              stockStatus
            }
          }
        }
      `,
        tracking
      );

      const stockPriority: Record<string, number> = {
        High: 3,
        Medium: 2,
        Low: 1,
      };

      const isAvailable = (gpu: GpuTypesResponse['gpuTypes'][number]) => {
        const status = gpu.lowestPrice?.stockStatus;
        return !!status && status !== 'Out';
      };

      let gpuTypes = data.gpuTypes.filter((gpu) => gpu.id !== 'unknown');

      if (!params.includeUnavailable) {
        gpuTypes = gpuTypes.filter(isAvailable);
      }
      if (params.minMemoryGb) {
        gpuTypes = gpuTypes.filter(
          (gpu) => gpu.memoryInGb >= params.minMemoryGb!
        );
      }
      if (params.secureCloudOnly) {
        gpuTypes = gpuTypes.filter((gpu) => gpu.secureCloud);
      }
      if (params.communityCloudOnly) {
        gpuTypes = gpuTypes.filter((gpu) => gpu.communityCloud);
      }
      if (params.searchTerm) {
        const term = params.searchTerm.toLowerCase();
        gpuTypes = gpuTypes.filter(
          (gpu) =>
            gpu.id.toLowerCase().includes(term) ||
            gpu.displayName.toLowerCase().includes(term)
        );
      }

      gpuTypes.sort((a, b) => {
        const aP = stockPriority[a.lowestPrice?.stockStatus || ''] || 0;
        const bP = stockPriority[b.lowestPrice?.stockStatus || ''] || 0;
        if (bP !== aP) return bP - aP;
        return b.memoryInGb - a.memoryInGb;
      });

      const result = gpuTypes.map((gpu) => ({
        id: gpu.id,
        displayName: gpu.displayName,
        memoryGb: gpu.memoryInGb,
        secureCloud: gpu.secureCloud,
        communityCloud: gpu.communityCloud,
        stockStatus: gpu.lowestPrice?.stockStatus || 'unavailable',
        available: isAvailable(gpu),
      }));

      return jsonReply(result);
    }
  );

  // List Data Centers
  server.tool(
    'list-data-centers',
    {
      region: z
        .string()
        .optional()
        .describe(
          "Filter by region/location (e.g., 'United States', 'Europe', 'Canada')"
        ),
    },
    async (params) => {
      interface DataCentersResponse {
        dataCenters: Array<{
          id: string;
          name: string;
          location: string;
        }>;
      }

      const data = await graphqlRequest<DataCentersResponse>(
        `
        query {
          dataCenters {
            id
            name
            location
          }
        }
      `,
        tracking
      );

      let dataCenters = data.dataCenters;

      if (params.region) {
        const term = params.region.toLowerCase();
        dataCenters = dataCenters.filter((dc) =>
          dc.location.toLowerCase().includes(term)
        );
      }

      return jsonReply(dataCenters);
    }
  );

  // ============== POD MANAGEMENT TOOLS ==============

  // List Pods
  server.tool(
    'list-pods',
    {
      ...listPaginationParams,
      computeType: z
        .enum(['GPU', 'CPU'])
        .optional()
        .describe('Filter to only GPU or only CPU Pods'),
      gpuTypeId: z
        .array(z.string())
        .optional()
        .describe('Filter to Pods with any of the listed GPU types'),
      dataCenterId: z
        .array(z.string())
        .optional()
        .describe('Filter to Pods in any of the provided data centers'),
      name: z
        .string()
        .optional()
        .describe('Filter to Pods with the provided name'),
      includeMachine: z
        .boolean()
        .optional()
        .describe('Include information about the machine'),
      includeNetworkVolume: z
        .boolean()
        .optional()
        .describe('Include information about attached network volumes'),
    },
    async (params) => {
      const backend = backendFor('pods');

      // v1 supports query-param filters; v2 has none (the spec declares no query
      // params and ignores them), so we only build the query string under v1.
      let queryString = '';
      if (backend.version === 'v1') {
        const queryParams = new URLSearchParams();
        if (params.computeType)
          queryParams.append('computeType', params.computeType);
        if (params.gpuTypeId)
          params.gpuTypeId.forEach((type) =>
            queryParams.append('gpuTypeId', type)
          );
        if (params.dataCenterId)
          params.dataCenterId.forEach((dc) =>
            queryParams.append('dataCenterId', dc)
          );
        if (params.name) queryParams.append('name', params.name);
        if (params.includeMachine)
          queryParams.append(
            'includeMachine',
            params.includeMachine.toString()
          );
        if (params.includeNetworkVolume)
          queryParams.append(
            'includeNetworkVolume',
            params.includeNetworkVolume.toString()
          );
        queryString = queryParams.toString()
          ? `?${queryParams.toString()}`
          : '';
      }

      const result = await callRestUrl(
        `${backend.base}${backend.list}${queryString}`
      );

      return capListResult(backend.unwrap(result), {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get Pod Details
  server.tool(
    'get-pod',
    {
      podId: z.string().describe('ID of the pod to retrieve'),
      includeMachine: z
        .boolean()
        .optional()
        .describe('Include information about the machine'),
      includeNetworkVolume: z
        .boolean()
        .optional()
        .describe('Include information about attached network volumes'),
    },
    async (params) => {
      const backend = backendFor('pods');

      // v1-only expansion query params (v2 has no query params on get).
      let queryString = '';
      if (backend.version === 'v1') {
        const queryParams = new URLSearchParams();
        if (params.includeMachine)
          queryParams.append(
            'includeMachine',
            params.includeMachine.toString()
          );
        if (params.includeNetworkVolume)
          queryParams.append(
            'includeNetworkVolume',
            params.includeNetworkVolume.toString()
          );
        queryString = queryParams.toString()
          ? `?${queryParams.toString()}`
          : '';
      }

      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.podId)}${queryString}`
      );
      return jsonReply(result);
    }
  );

  // Create Pod
  server.tool(
    'create-pod',
    'Create a new GPU/CPU pod on Runpod. If the user does not specify an image, recommend the "Runpod Pytorch 2.8.0" image (runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404) as the default — it has the most up-to-date CUDA and PyTorch versions.',
    {
      name: z.string().optional().describe('Name for the pod'),
      imageName: z.string().describe('Docker image to use'),
      cloudType: z
        .enum(['SECURE', 'COMMUNITY'])
        .optional()
        .describe('SECURE or COMMUNITY cloud'),
      gpuTypeIds: z
        .array(z.string())
        .optional()
        .describe('List of acceptable GPU types'),
      gpuCount: z.number().optional().describe('Number of GPUs'),
      containerDiskInGb: z
        .number()
        .optional()
        .describe('Container disk size in GB'),
      volumeInGb: z.number().optional().describe('Volume size in GB'),
      volumeMountPath: z
        .string()
        .optional()
        .describe('Path to mount the volume'),
      ports: z
        .array(z.string())
        .optional()
        .describe("Ports to expose (e.g., '8888/http', '22/tcp')"),
      env: z.record(z.string()).optional().describe('Environment variables'),
      dataCenterIds: z
        .array(z.string())
        .optional()
        .describe('List of data centers'),
    },
    async (params) => {
      const backend = backendFor('pods');
      const body = backend.mapCreate(params) as Record<string, unknown>;
      try {
        const result = await callRestUrl(
          `${backend.base}${backend.list}`,
          'POST',
          body
        );
        return jsonReply(result);
      } catch (error) {
        // C2: v2 stubs CPU-pod creation with 501 (AE-2991). Surface a clean,
        // non-error message instead of a raw stack so the agent understands.
        if (error instanceof HttpError && error.status === 501) {
          return jsonReply({
            error:
              'CPU pods are not yet supported on the v2 REST API. Use a GPU pod, or create the CPU pod via the v1 API (set RUNPOD_REST_VERSION=v1).',
            status: 501,
          });
        }
        throw error;
      }
    }
  );

  // Update Pod
  server.tool(
    'update-pod',
    {
      podId: z.string().describe('ID of the pod to update'),
      name: z.string().optional().describe('New name for the pod'),
      imageName: z.string().optional().describe('New Docker image'),
      containerDiskInGb: z
        .number()
        .optional()
        .describe('New container disk size in GB'),
      volumeInGb: z.number().optional().describe('New volume size in GB'),
      volumeMountPath: z
        .string()
        .optional()
        .describe('New path to mount the volume'),
      ports: z.array(z.string()).optional().describe('New ports to expose'),
      env: z
        .record(z.string())
        .optional()
        .describe('New environment variables'),
    },
    async (params) => {
      const { podId, ...updateParams } = params;
      const backend = backendFor('pods');
      const body = backend.mapUpdate(updateParams) as Record<string, unknown>;
      const result = await callRestUrl(
        `${backend.base}${backend.get!(podId)}`,
        'PATCH',
        body
      );
      return jsonReply(result);
    }
  );

  // Start Pod — v1: POST /pods/{id}/start ; v2: POST /pods/{id}/action {action:'start'}
  server.tool(
    'start-pod',
    {
      podId: z.string().describe('ID of the pod to start'),
    },
    async (params) => {
      const result = await podAction(params.podId, 'start');
      return jsonReply(result);
    }
  );

  // Stop Pod — v1: POST /pods/{id}/stop ; v2: POST /pods/{id}/action {action:'stop'}
  server.tool(
    'stop-pod',
    {
      podId: z.string().describe('ID of the pod to stop'),
    },
    async (params) => {
      const result = await podAction(params.podId, 'stop');
      return jsonReply(result);
    }
  );

  // Restart Pod — v2-only state transition (PodAction enum); under v1 this hits
  // /pods/{id}/restart which the v1 REST API does not implement.
  server.tool(
    'restart-pod',
    {
      podId: z.string().describe('ID of the pod to restart'),
    },
    async (params) => {
      const result = await podAction(params.podId, 'restart');
      return jsonReply(result);
    }
  );

  // Delete Pod
  server.tool(
    'delete-pod',
    {
      podId: z.string().describe('ID of the pod to delete'),
    },
    async (params) => {
      const backend = backendFor('pods');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.podId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );

  // ============== ENDPOINT MANAGEMENT TOOLS ==============

  // List Endpoints
  server.tool(
    'list-endpoints',
    {
      ...listPaginationParams,
      includeTemplate: z
        .boolean()
        .optional()
        .describe('Include template information'),
      includeWorkers: z
        .boolean()
        .optional()
        .describe('Include information about workers'),
    },
    async (params) => {
      const queryParams = new URLSearchParams();

      if (params.includeTemplate)
        queryParams.append(
          'includeTemplate',
          params.includeTemplate.toString()
        );
      if (params.includeWorkers)
        queryParams.append('includeWorkers', params.includeWorkers.toString());

      const queryString = queryParams.toString()
        ? `?${queryParams.toString()}`
        : '';
      const result = await runpodRequest(`/endpoints${queryString}`);

      return capListResult(result, {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get Endpoint Details
  server.tool(
    'get-endpoint',
    {
      endpointId: z.string().describe('ID of the endpoint to retrieve'),
      includeTemplate: z
        .boolean()
        .optional()
        .describe('Include template information'),
      includeWorkers: z
        .boolean()
        .optional()
        .describe('Include information about workers'),
    },
    async (params) => {
      const queryParams = new URLSearchParams();

      if (params.includeTemplate)
        queryParams.append(
          'includeTemplate',
          params.includeTemplate.toString()
        );
      if (params.includeWorkers)
        queryParams.append('includeWorkers', params.includeWorkers.toString());

      const queryString = queryParams.toString()
        ? `?${queryParams.toString()}`
        : '';
      const result = await runpodRequest(
        `/endpoints/${params.endpointId}${queryString}`
      );

      return jsonReply(result);
    }
  );

  // Create Endpoint
  server.tool(
    'create-endpoint',
    {
      name: z.string().optional().describe('Name for the endpoint'),
      templateId: z.string().describe('Template ID to use'),
      computeType: z
        .enum(['GPU', 'CPU'])
        .optional()
        .describe('GPU or CPU endpoint'),
      gpuTypeIds: z
        .array(z.string())
        .optional()
        .describe('List of acceptable GPU types'),
      gpuCount: z.number().optional().describe('Number of GPUs per worker'),
      workersMin: z.number().optional().describe('Minimum number of workers'),
      workersMax: z.number().optional().describe('Maximum number of workers'),
      dataCenterIds: z
        .array(z.string())
        .optional()
        .describe('List of data centers'),
    },
    async (params) => {
      const result = await runpodRequest('/endpoints', 'POST', params);

      return jsonReply(result);
    }
  );

  // Update Endpoint
  server.tool(
    'update-endpoint',
    {
      endpointId: z.string().describe('ID of the endpoint to update'),
      name: z.string().optional().describe('New name for the endpoint'),
      workersMin: z
        .number()
        .optional()
        .describe('New minimum number of workers'),
      workersMax: z
        .number()
        .optional()
        .describe('New maximum number of workers'),
      idleTimeout: z
        .number()
        .optional()
        .describe('New idle timeout in seconds'),
      scalerType: z
        .enum(['QUEUE_DELAY', 'REQUEST_COUNT'])
        .optional()
        .describe('Scaler type'),
      scalerValue: z.number().optional().describe('Scaler value'),
    },
    async (params) => {
      const { endpointId, ...updateParams } = params;
      const result = await runpodRequest(
        `/endpoints/${endpointId}`,
        'PATCH',
        updateParams
      );

      return jsonReply(result);
    }
  );

  // Delete Endpoint
  server.tool(
    'delete-endpoint',
    {
      endpointId: z.string().describe('ID of the endpoint to delete'),
    },
    async (params) => {
      const result = await runpodRequest(
        `/endpoints/${params.endpointId}`,
        'DELETE'
      );

      return jsonReply(result);
    }
  );

  // ============== SERVERLESS RUNTIME TOOLS ==============

  // Shared schemas for serverless tools
  const endpointIdSchema = z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid endpoint ID format');

  const jobIdSchema = z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid job ID format');

  const inputSchema = z
    .record(z.unknown())
    .describe(
      'Input payload for the worker handler. The expected fields depend on the deployed model or worker.'
    );

  const webhookSchema = z
    .string()
    .url()
    .optional()
    .describe(
      'Webhook URL to receive job completion notifications instead of polling'
    );

  const policySchema = z
    .object({
      executionTimeout: z
        .number()
        .optional()
        .describe('Maximum execution time in milliseconds'),
      lowPriority: z
        .boolean()
        .optional()
        .describe('Submit as a low-priority job'),
      ttl: z
        .number()
        .optional()
        .describe('Time-to-live for the job result in milliseconds'),
    })
    .optional()
    .describe('Execution policy options');

  const s3ConfigSchema = z
    .object({
      accessId: z.string().describe('S3 access key ID'),
      accessSecret: z.string().describe('S3 secret access key'),
      bucketName: z.string().describe('S3 bucket name'),
      endpointUrl: z.string().describe('S3 endpoint URL'),
    })
    .optional()
    .describe('S3-compatible storage config for large outputs');

  // Run Endpoint (Async)
  server.tool(
    'run-endpoint',
    'Submit an asynchronous job to a Serverless endpoint. Returns a job ID immediately — use get-job-status to poll for results. Async results are available for 30 minutes after completion.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint to run'
      ),
      input: inputSchema,
      webhook: webhookSchema,
      policy: policySchema,
      s3Config: s3ConfigSchema,
    },
    async (params) => {
      const { endpointId, ...body } = params;
      const result = await serverlessRequest(
        endpointId,
        '/run',
        'POST',
        body as Record<string, unknown>
      );

      return jsonReply(result);
    }
  );

  // Run Endpoint Sync
  server.tool(
    'runsync-endpoint',
    'Submit a synchronous job to a Serverless endpoint and wait for the result. Best for tasks completing within 90 seconds. If processing exceeds 90 seconds, the response returns a job ID to poll with get-job-status. Max payload: 20 MB. Results expire after 1 minute. Use the wait parameter to extend the server-side wait up to 5 minutes (300000 ms).',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint to run synchronously'
      ),
      input: inputSchema,
      wait: z
        .number()
        .min(1000)
        .max(300000)
        .optional()
        .describe(
          'How long in milliseconds the server should wait for a result before returning a job ID to poll (1000–300000). Defaults to 90000 (90 seconds).'
        ),
      webhook: webhookSchema,
      policy: policySchema,
      s3Config: s3ConfigSchema,
    },
    async (params) => {
      const { endpointId, wait, ...body } = params;
      const path = wait ? `/runsync?wait=${wait}` : '/runsync';
      const result = await serverlessRequest(
        endpointId,
        path,
        'POST',
        body as Record<string, unknown>
      );

      return jsonReply(result);
    }
  );

  // Get Job Status
  server.tool(
    'get-job-status',
    'Check the status of an asynchronous Serverless job. Returns the current status and output when complete. Job statuses: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, CANCELLED, TIMED_OUT.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint the job belongs to'
      ),
      jobId: jobIdSchema.describe('ID of the job to check'),
    },
    async (params) => {
      const result = await serverlessRequest(
        params.endpointId,
        `/status/${params.jobId}`
      );

      return jsonReply(result);
    }
  );

  // Stream Job Results
  server.tool(
    'stream-job',
    'Retrieve all streaming output from a Serverless job by polling until the job reaches a terminal state. The worker must support streaming output. Polls /stream/{jobId} repeatedly and collects every chunk until status is COMPLETED, FAILED, CANCELLED, or TIMED_OUT.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint the job belongs to'
      ),
      jobId: jobIdSchema.describe('ID of the job to stream results from'),
    },
    async (params) => {
      const TERMINAL_STATUSES = new Set([
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'TIMED_OUT',
      ]);
      const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes
      const POLL_INTERVAL_MS = 1000;
      const MAX_CONSECUTIVE_ERRORS = 5;
      const allChunks: unknown[] = [];
      let finalResult: Record<string, unknown> = {};
      let consecutiveErrors = 0;
      let lastError: string | undefined;
      const startTime = Date.now();

      while (true) {
        try {
          const result = (await serverlessRequest(
            params.endpointId,
            `/stream/${params.jobId}`
          )) as Record<string, unknown>;

          consecutiveErrors = 0;

          if (Array.isArray(result.stream)) {
            allChunks.push(...result.stream);
          }

          finalResult = result;

          if (TERMINAL_STATUSES.has(result.status as string)) {
            break;
          }
        } catch (error) {
          consecutiveErrors++;
          lastError = error instanceof Error ? error.message : String(error);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            finalResult.error = `Polling aborted after ${MAX_CONSECUTIVE_ERRORS} consecutive errors: ${lastError}`;
            break;
          }
        }

        if (Date.now() - startTime > MAX_POLL_TIME_MS) {
          finalResult.pollingTimedOut = true;
          finalResult.note =
            'Polling timed out after 5 minutes. Use get-job-status to check the job later.';
          // Surface the most recent error (if any) instead of discarding it —
          // the last poll may have been failing (e.g. job expired) even though
          // earlier polls succeeded.
          if (lastError) finalResult.lastError = lastError;
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      return jsonReply({ ...finalResult, stream: allChunks });
    }
  );

  // Cancel Job
  server.tool(
    'cancel-job',
    'Cancel a Serverless job that is queued or in progress.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint the job belongs to'
      ),
      jobId: jobIdSchema.describe('ID of the job to cancel'),
    },
    async (params) => {
      const result = await serverlessRequest(
        params.endpointId,
        `/cancel/${params.jobId}`,
        'POST'
      );

      return jsonReply(result);
    }
  );

  // Retry Job
  server.tool(
    'retry-job',
    'Retry a failed or timed-out Serverless job. Only works for jobs with FAILED or TIMED_OUT status. The previous output is removed and the job is requeued.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint the job belongs to'
      ),
      jobId: jobIdSchema.describe('ID of the job to retry'),
    },
    async (params) => {
      const result = await serverlessRequest(
        params.endpointId,
        `/retry/${params.jobId}`,
        'POST'
      );

      return jsonReply(result);
    }
  );

  // Endpoint Health
  server.tool(
    'endpoint-health',
    'Get the health and operational status of a Serverless endpoint, including worker counts and job statistics.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint to check health for'
      ),
    },
    async (params) => {
      const result = await serverlessRequest(params.endpointId, '/health');

      return jsonReply(result);
    }
  );

  // Purge Endpoint Queue
  server.tool(
    'purge-endpoint-queue',
    'Remove all pending jobs from a Serverless endpoint queue. Only affects queued jobs — in-progress jobs continue running. Use this for error recovery or clearing outdated requests.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint to purge the queue for'
      ),
    },
    async (params) => {
      const result = await serverlessRequest(
        params.endpointId,
        '/purge-queue',
        'POST'
      );

      return jsonReply(result);
    }
  );

  // ============== TEMPLATE MANAGEMENT TOOLS ==============

  // List Templates
  server.tool(
    'list-templates',
    'List available templates. By default returns only the user\'s own templates. Use includeRunpodTemplates to also include official Runpod templates. The recommended default template for new pods is "Runpod Pytorch 2.8.0" (ID: runpod-torch-v280) — it has the latest CUDA and PyTorch versions.',
    {
      ...listPaginationParams,
      includeRunpodTemplates: z
        .boolean()
        .optional()
        .describe('Include official Runpod templates in the response'),
      includePublicTemplates: z
        .boolean()
        .optional()
        .describe('Include community-made public templates in the response'),
      includeEndpointBoundTemplates: z
        .boolean()
        .optional()
        .describe(
          'Include templates bound to Serverless endpoints in the response'
        ),
    },
    async (params) => {
      const backend = backendFor('templates');
      let query = '';
      if (backend.version === 'v1') {
        const queryParams = new URLSearchParams();
        if (params.includeRunpodTemplates)
          queryParams.set('includeRunpodTemplates', 'true');
        if (params.includePublicTemplates)
          queryParams.set('includePublicTemplates', 'true');
        if (params.includeEndpointBoundTemplates)
          queryParams.set('includeEndpointBoundTemplates', 'true');
        query = queryParams.toString() ? `?${queryParams.toString()}` : '';
      }
      const result = await callRestUrl(
        `${backend.base}${backend.list}${query}`
      );

      return capListResult(backend.unwrap(result), {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get Template Details
  server.tool(
    'get-template',
    {
      templateId: z.string().describe('ID of the template to retrieve'),
    },
    async (params) => {
      const backend = backendFor('templates');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.templateId)}`
      );
      return jsonReply(result);
    }
  );

  // Create Template
  server.tool(
    'create-template',
    {
      name: z.string().describe('Name for the template'),
      imageName: z.string().describe('Docker image to use'),
      isServerless: z
        .boolean()
        .optional()
        .describe('Is this a serverless template'),
      ports: z.array(z.string()).optional().describe('Ports to expose'),
      dockerEntrypoint: z
        .array(z.string())
        .optional()
        .describe('Docker entrypoint commands'),
      dockerStartCmd: z
        .array(z.string())
        .optional()
        .describe('Docker start commands'),
      env: z.record(z.string()).optional().describe('Environment variables'),
      containerDiskInGb: z
        .number()
        .optional()
        .describe('Container disk size in GB'),
      volumeInGb: z.number().optional().describe('Volume size in GB'),
      volumeMountPath: z
        .string()
        .optional()
        .describe('Path to mount the volume'),
      readme: z
        .string()
        .optional()
        .describe('README content in markdown format'),
    },
    async (params) => {
      const backend = backendFor('templates');
      const body = backend.mapCreate(params) as Record<string, unknown>;
      const result = await callRestUrl(
        `${backend.base}${backend.list}`,
        'POST',
        body
      );
      return jsonReply(result);
    }
  );

  // Update Template
  server.tool(
    'update-template',
    {
      templateId: z.string().describe('ID of the template to update'),
      name: z.string().optional().describe('New name for the template'),
      imageName: z.string().optional().describe('New Docker image'),
      ports: z.array(z.string()).optional().describe('New ports to expose'),
      env: z
        .record(z.string())
        .optional()
        .describe('New environment variables'),
      readme: z
        .string()
        .optional()
        .describe('New README content in markdown format'),
    },
    async (params) => {
      const { templateId, ...updateParams } = params;
      const backend = backendFor('templates');
      const body = backend.mapUpdate(updateParams) as Record<string, unknown>;
      const result = await callRestUrl(
        `${backend.base}${backend.get!(templateId)}`,
        'PATCH',
        body
      );
      return jsonReply(result);
    }
  );

  // Delete Template
  server.tool(
    'delete-template',
    {
      templateId: z.string().describe('ID of the template to delete'),
    },
    async (params) => {
      const backend = backendFor('templates');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.templateId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );

  // ============== NETWORK VOLUME MANAGEMENT TOOLS ==============

  // List Network Volumes
  server.tool('list-network-volumes', listPaginationParams, async (params) => {
    const backend = backendFor('networkVolumes');
    const result = await callRestUrl(`${backend.base}${backend.list}`);

    return capListResult(backend.unwrap(result), {
      limit: params.limit,
      cursor: params.cursor,
    });
  });

  // Get Network Volume Details
  server.tool(
    'get-network-volume',
    {
      networkVolumeId: z
        .string()
        .describe('ID of the network volume to retrieve'),
    },
    async (params) => {
      const backend = backendFor('networkVolumes');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.networkVolumeId)}`
      );
      return jsonReply(result);
    }
  );

  // Create Network Volume
  server.tool(
    'create-network-volume',
    {
      name: z.string().describe('Name for the network volume'),
      size: z.number().describe('Size in GB (1-4000)'),
      dataCenterId: z.string().describe('Data center ID'),
    },
    async (params) => {
      const backend = backendFor('networkVolumes');
      const body = backend.mapCreate(params) as Record<string, unknown>;
      const result = await callRestUrl(
        `${backend.base}${backend.list}`,
        'POST',
        body
      );
      return jsonReply(result);
    }
  );

  // Update Network Volume
  server.tool(
    'update-network-volume',
    {
      networkVolumeId: z
        .string()
        .describe('ID of the network volume to update'),
      name: z.string().optional().describe('New name for the network volume'),
      size: z
        .number()
        .optional()
        .describe('New size in GB (must be larger than current)'),
    },
    async (params) => {
      const { networkVolumeId, ...updateParams } = params;
      const backend = backendFor('networkVolumes');
      const body = backend.mapUpdate(updateParams) as Record<string, unknown>;
      const result = await callRestUrl(
        `${backend.base}${backend.get!(networkVolumeId)}`,
        'PATCH',
        body
      );
      return jsonReply(result);
    }
  );

  // Delete Network Volume
  server.tool(
    'delete-network-volume',
    {
      networkVolumeId: z
        .string()
        .describe('ID of the network volume to delete'),
    },
    async (params) => {
      const backend = backendFor('networkVolumes');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.networkVolumeId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );

  // ============== CONTAINER REGISTRY AUTH TOOLS ==============

  // List Container Registry Auths
  server.tool(
    'list-container-registry-auths',
    listPaginationParams,
    async (params) => {
      const backend = backendFor('registries');
      const result = await callRestUrl(`${backend.base}${backend.list}`);

      return capListResult(backend.unwrap(result), {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get Container Registry Auth Details
  server.tool(
    'get-container-registry-auth',
    {
      containerRegistryAuthId: z
        .string()
        .describe('ID of the container registry auth to retrieve'),
    },
    async (params) => {
      const backend = backendFor('registries');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.containerRegistryAuthId)}`
      );
      return jsonReply(result);
    }
  );

  // Create Container Registry Auth
  server.tool(
    'create-container-registry-auth',
    {
      name: z.string().describe('Name for the container registry auth'),
      username: z.string().describe('Registry username'),
      password: z.string().describe('Registry password'),
    },
    async (params) => {
      const backend = backendFor('registries');
      const body = backend.mapCreate(params) as Record<string, unknown>;
      const result = await callRestUrl(
        `${backend.base}${backend.list}`,
        'POST',
        body
      );
      return jsonReply(result);
    }
  );

  // Delete Container Registry Auth
  server.tool(
    'delete-container-registry-auth',
    {
      containerRegistryAuthId: z
        .string()
        .describe('ID of the container registry auth to delete'),
    },
    async (params) => {
      const backend = backendFor('registries');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.containerRegistryAuthId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );
}
