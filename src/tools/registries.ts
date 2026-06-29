import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, WRITE, DESTRUCTIVE, type ToolRuntime } from './runtime.js';

// ============== CONTAINER REGISTRY AUTH TOOLS ==============

export function registerRegistryTools(
  server: McpServer,
  rt: ToolRuntime
): void {
  const { jsonReply, callRestUrl, backendFor } = rt;

  // List Container Registry Auths
  server.tool(
    'list-container-registry-auths',
    'List your saved container-registry credentials (private image-pull auth). Paginated via limit/cursor.',
    listPaginationParams,
    { title: 'List container registry auths', ...READ_ONLY },
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
    'Get one saved container-registry credential by id (the secret/password is not returned).',
    {
      containerRegistryAuthId: z
        .string()
        .describe('ID of the container registry auth to retrieve'),
    },
    { title: 'Get container registry auth', ...READ_ONLY },
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
    'Save container-registry credentials (username + password/token) so pods and endpoints can pull private images.',
    {
      name: z.string().describe('Name for the container registry auth'),
      username: z.string().describe('Registry username'),
      password: z
        .string()
        .describe('Registry password or access token (stored as a secret)'),
    },
    { title: 'Create container registry auth', ...WRITE },
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
    'Permanently delete a saved container-registry credential. This cannot be undone.',
    {
      containerRegistryAuthId: z
        .string()
        .describe('ID of the container registry auth to delete'),
    },
    { title: 'Delete container registry auth', ...DESTRUCTIVE },
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
