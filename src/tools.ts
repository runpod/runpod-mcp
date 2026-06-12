import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fetch, { type RequestInit as NodeFetchRequestInit } from 'node-fetch';
import { randomUUID } from 'node:crypto';

// Base URL for Runpod REST API. Override via RUNPOD_REST_API_URL to point at a
// non-production environment (e.g. when authenticating with a dev API key).
const API_BASE_URL =
  process.env.RUNPOD_REST_API_URL ?? 'https://rest.runpod.io/v1';

// Serverless API base URL for endpoint runtime operations (run, status, cancel, etc.).
// Override via RUNPOD_SERVERLESS_API_URL for non-production environments.
const SERVERLESS_API_BASE_URL =
  process.env.RUNPOD_SERVERLESS_API_URL ?? 'https://api.runpod.ai/v2';

// GraphQL endpoint for public queries (GPU types, data centers)
const GRAPHQL_URL = 'https://api.runpod.io/graphql';

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
 * Sanitizes a value for inclusion in a User-Agent token. RFC 7230 reserves
 * parens and a few other chars; strip them so the structured UA stays
 * parseable, and bound the length so a hostile client can't blow up a header.
 */
function sanitizeUaToken(value: string): string {
  return value.replace(/[()<>@,;:\\"/[\]?={}\s]/g, '_').slice(0, 64);
}

/**
 * Builds the headers that identify the calling MCP client and session on every
 * outbound HTTP call. Client identity comes from the `initialize` handshake's
 * `clientInfo`, exposed by the SDK via `server.server.getClientVersion()`.
 */
function trackingHeaders(
  server: McpServer,
  transport: ToolContext['transport']
): Record<string, string> {
  const info = server.server.getClientVersion();
  const name = sanitizeUaToken(info?.name || 'unknown');
  const version = sanitizeUaToken(info?.version || 'unknown');
  const userAgent = `runpod-mcp-server/${MCP_SERVER_VERSION} (caller=mcp; client=${name}; client_version=${version}; transport=${transport})`;
  return {
    'User-Agent': userAgent,
    'X-Runpod-Session-Id': SESSION_ID,
  };
}

/**
 * Context passed to every tool handler. Contains the API key used to
 * authenticate against the Runpod REST and Serverless APIs, and the transport
 * the server is running under (for outbound caller-tracking headers).
 */
export interface ToolContext {
  apiKey: string;
  transport: 'stdio' | 'http';
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
function createRunpodRequest(
  apiKey: string,
  tracking: () => Record<string, string>
) {
  return async function runpodRequest(
    endpoint: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ) {
    const url = `${API_BASE_URL}${endpoint}`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...tracking(),
    };

    const options: NodeFetchRequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Runpod API Error: ${response.status} - ${errorText}`);
      }

      // Some endpoints might not return JSON
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }

      return { success: true, status: response.status };
    } catch (error) {
      console.error('Error calling Runpod API:', error);
      throw error;
    }
  };
}

// Helper function to make authenticated requests to the Serverless runtime API
function createServerlessRequest(
  apiKey: string,
  tracking: () => Record<string, string>
) {
  return async function serverlessRequest(
    endpointId: string,
    path: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ) {
    const url = `${SERVERLESS_API_BASE_URL}/${endpointId}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...tracking(),
    };

    const options: NodeFetchRequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Runpod Serverless API Error: ${response.status} - ${errorText}`
        );
      }

      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        return await response.json();
      }

      return { success: true, status: response.status };
    } catch (error) {
      console.error('Error calling Runpod Serverless API:', error);
      throw error;
    }
  };
}

/**
 * Register all Runpod tools on the given MCP server instance. The provided
 * context supplies the API key that authenticated request helpers will use.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  const tracking = () => trackingHeaders(server, ctx.transport);
  const runpodRequest = createRunpodRequest(ctx.apiKey, tracking);
  const serverlessRequest = createServerlessRequest(ctx.apiKey, tracking);

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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(dataCenters, null, 2),
          },
        ],
      };
    }
  );

  // ============== POD MANAGEMENT TOOLS ==============

  // List Pods
  server.tool(
    'list-pods',
    {
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
        queryParams.append('includeMachine', params.includeMachine.toString());
      if (params.includeNetworkVolume)
        queryParams.append(
          'includeNetworkVolume',
          params.includeNetworkVolume.toString()
        );

      const queryString = queryParams.toString()
        ? `?${queryParams.toString()}`
        : '';
      const result = await runpodRequest(`/pods${queryString}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const queryParams = new URLSearchParams();

      if (params.includeMachine)
        queryParams.append('includeMachine', params.includeMachine.toString());
      if (params.includeNetworkVolume)
        queryParams.append(
          'includeNetworkVolume',
          params.includeNetworkVolume.toString()
        );

      const queryString = queryParams.toString()
        ? `?${queryParams.toString()}`
        : '';
      const result = await runpodRequest(`/pods/${params.podId}${queryString}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const result = await runpodRequest('/pods', 'POST', params);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const result = await runpodRequest(
        `/pods/${podId}`,
        'PATCH',
        updateParams
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Start Pod
  server.tool(
    'start-pod',
    {
      podId: z.string().describe('ID of the pod to start'),
    },
    async (params) => {
      const result = await runpodRequest(`/pods/${params.podId}/start`, 'POST');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Stop Pod
  server.tool(
    'stop-pod',
    {
      podId: z.string().describe('ID of the pod to stop'),
    },
    async (params) => {
      const result = await runpodRequest(`/pods/${params.podId}/stop`, 'POST');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Delete Pod
  server.tool(
    'delete-pod',
    {
      podId: z.string().describe('ID of the pod to delete'),
    },
    async (params) => {
      const result = await runpodRequest(`/pods/${params.podId}`, 'DELETE');

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ============== ENDPOINT MANAGEMENT TOOLS ==============

  // List Endpoints
  server.tool(
    'list-endpoints',
    {
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            finalResult.error = `Polling aborted after ${MAX_CONSECUTIVE_ERRORS} consecutive errors: ${error instanceof Error ? error.message : String(error)}`;
            break;
          }
        }

        if (Date.now() - startTime > MAX_POLL_TIME_MS) {
          finalResult.pollingTimedOut = true;
          finalResult.note =
            'Polling timed out after 5 minutes. Use get-job-status to check the job later.';
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { ...finalResult, stream: allChunks },
              null,
              2
            ),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ============== TEMPLATE MANAGEMENT TOOLS ==============

  // List Templates
  server.tool(
    'list-templates',
    'List available templates. By default returns only the user\'s own templates. Use includeRunpodTemplates to also include official Runpod templates. The recommended default template for new pods is "Runpod Pytorch 2.8.0" (ID: runpod-torch-v280) — it has the latest CUDA and PyTorch versions.',
    {
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
      const queryParams = new URLSearchParams();
      if (params.includeRunpodTemplates)
        queryParams.set('includeRunpodTemplates', 'true');
      if (params.includePublicTemplates)
        queryParams.set('includePublicTemplates', 'true');
      if (params.includeEndpointBoundTemplates)
        queryParams.set('includeEndpointBoundTemplates', 'true');
      const query = queryParams.toString();
      const result = await runpodRequest(
        `/templates${query ? `?${query}` : ''}`
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Get Template Details
  server.tool(
    'get-template',
    {
      templateId: z.string().describe('ID of the template to retrieve'),
    },
    async (params) => {
      const result = await runpodRequest(`/templates/${params.templateId}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const result = await runpodRequest('/templates', 'POST', params);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const result = await runpodRequest(
        `/templates/${templateId}`,
        'PATCH',
        updateParams
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // Delete Template
  server.tool(
    'delete-template',
    {
      templateId: z.string().describe('ID of the template to delete'),
    },
    async (params) => {
      const result = await runpodRequest(
        `/templates/${params.templateId}`,
        'DELETE'
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ============== NETWORK VOLUME MANAGEMENT TOOLS ==============

  // List Network Volumes
  server.tool('list-network-volumes', {}, async () => {
    const result = await runpodRequest('/networkvolumes');

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
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
      const result = await runpodRequest(
        `/networkvolumes/${params.networkVolumeId}`
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const result = await runpodRequest('/networkvolumes', 'POST', params);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const result = await runpodRequest(
        `/networkvolumes/${networkVolumeId}`,
        'PATCH',
        updateParams
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const result = await runpodRequest(
        `/networkvolumes/${params.networkVolumeId}`,
        'DELETE'
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ============== CONTAINER REGISTRY AUTH TOOLS ==============

  // List Container Registry Auths
  server.tool('list-container-registry-auths', {}, async () => {
    const result = await runpodRequest('/containerregistryauth');

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  });

  // Get Container Registry Auth Details
  server.tool(
    'get-container-registry-auth',
    {
      containerRegistryAuthId: z
        .string()
        .describe('ID of the container registry auth to retrieve'),
    },
    async (params) => {
      const result = await runpodRequest(
        `/containerregistryauth/${params.containerRegistryAuthId}`
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const result = await runpodRequest(
        '/containerregistryauth',
        'POST',
        params
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
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
      const result = await runpodRequest(
        `/containerregistryauth/${params.containerRegistryAuthId}`,
        'DELETE'
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
