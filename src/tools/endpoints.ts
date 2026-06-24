import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, WRITE, DESTRUCTIVE, type ToolRuntime } from './runtime.js';

// ============== ENDPOINT MANAGEMENT TOOLS ==============
// Serverless endpoint CRUD. Pinned to the v1 REST API (the adapter marks
// `endpoints` v1-only): v2 exposes endpoints under /v2/serverless, but routing
// the write path there is a separate, live-verified change.

export function registerEndpointTools(
  server: McpServer,
  rt: ToolRuntime
): void {
  const { jsonReply, runpodRequest } = rt;

  // List Endpoints
  server.tool(
    'list-endpoints',
    'List your Serverless endpoints, optionally expanding template and worker details. Paginated via limit/cursor.',
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
    { title: 'List endpoints', ...READ_ONLY },
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
    'Get one Serverless endpoint by id, optionally expanding template and worker details.',
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
    { title: 'Get endpoint', ...READ_ONLY },
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
    'Create a Serverless endpoint from a template, with GPU/CPU compute and worker min/max autoscaling.',
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
    { title: 'Create endpoint', ...WRITE },
    async (params) => {
      const result = await runpodRequest('/endpoints', 'POST', params);

      return jsonReply(result);
    }
  );

  // Update Endpoint
  server.tool(
    'update-endpoint',
    "Update a Serverless endpoint's scaling/config (worker min/max, idle timeout, scaler type/value, name). Only provided fields change.",
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
    { title: 'Update endpoint', ...WRITE, idempotentHint: true },
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
    'Permanently delete a Serverless endpoint. This cannot be undone.',
    {
      endpointId: z.string().describe('ID of the endpoint to delete'),
    },
    { title: 'Delete endpoint', ...DESTRUCTIVE },
    async (params) => {
      const result = await runpodRequest(
        `/endpoints/${params.endpointId}`,
        'DELETE'
      );

      return jsonReply(result);
    }
  );
}
