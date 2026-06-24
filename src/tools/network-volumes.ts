import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, WRITE, DESTRUCTIVE, type ToolRuntime } from './runtime.js';

// ============== NETWORK VOLUME MANAGEMENT TOOLS ==============

export function registerNetworkVolumeTools(
  server: McpServer,
  rt: ToolRuntime
): void {
  const { jsonReply, callRestUrl, backendFor } = rt;

  // List Network Volumes
  server.tool(
    'list-network-volumes',
    'List your network volumes (persistent storage attachable to pods). Paginated via limit/cursor.',
    listPaginationParams,
    { title: 'List network volumes', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('networkVolumes');
      const result = await callRestUrl(`${backend.base}${backend.list}`);

      return capListResult(backend.unwrap(result), {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get Network Volume Details
  server.tool(
    'get-network-volume',
    'Get one network volume by id (name, size, data center).',
    {
      networkVolumeId: z
        .string()
        .describe('ID of the network volume to retrieve'),
    },
    { title: 'Get network volume', ...READ_ONLY },
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
    'Create a persistent network volume in a data center (size 1–4000 GB) that pods can mount.',
    {
      name: z.string().describe('Name for the network volume'),
      size: z.number().describe('Size in GB (1-4000)'),
      dataCenterId: z
        .string()
        .describe('Data center ID (see list-data-centers)'),
    },
    { title: 'Create network volume', ...WRITE },
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
    'Update a network volume (rename, or grow size — the new size must exceed the current size). Only provided fields change.',
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
    { title: 'Update network volume', ...WRITE, idempotentHint: true },
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
    'Permanently delete a network volume and its data. This cannot be undone.',
    {
      networkVolumeId: z
        .string()
        .describe('ID of the network volume to delete'),
    },
    { title: 'Delete network volume', ...DESTRUCTIVE },
    async (params) => {
      const backend = backendFor('networkVolumes');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.networkVolumeId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );
}
