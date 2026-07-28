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
    'Create a persistent network volume in a data center (size 10–4096 GB) that pods can mount. Pass volumeType to pick a storage tier; omit it to get the data center default.',
    {
      name: z.string().describe('Name for the network volume'),
      // Bounds mirror the v2 spec (integer, minimum 10, maximum 4096). Enforced
      // here as well as described, so an out-of-range value fails locally
      // instead of costing an API roundtrip.
      size: z.number().int().min(10).max(4096).describe('Size in GB (10-4096)'),
      dataCenterId: z
        .string()
        .describe('Data center ID (see list-data-centers)'),
      volumeType: z
        .enum(['STANDARD', 'HIGH_PERFORMANCE'])
        .optional()
        .describe(
          "Storage tier. Omit for the data center's default (primary) tier. HIGH_PERFORMANCE provisions an HPS volume. Immutable after creation — update-network-volume cannot change it."
        ),
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
      // Same absolute bounds as create. "Larger than current" stays server-side —
      // we do not hold the current size here, so only the range is checked.
      size: z
        .number()
        .int()
        .min(10)
        .max(4096)
        .optional()
        .describe('New size in GB, 10-4096 (must be larger than current)'),
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
