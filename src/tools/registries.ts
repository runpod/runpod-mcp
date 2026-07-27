import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, WRITE, DESTRUCTIVE, type ToolRuntime } from './runtime.js';

// ============== CONTAINER REGISTRY TOOLS ==============
// Two related things live here, both under the v2 `registries` resource:
//
//   1. Container registry auths (`/v2/registries`) — a stored username +
//      password used to pull a private image. Available on v1 and v2.
//   2. ECR delegations (`/v2/registries/delegations`) — a different mechanism
//      for the same goal, specific to AWS ECR: instead of storing credentials,
//      you register an ECR repository ARN and Runpod is granted scoped pull
//      access to it, handing back a `dockerRegistryUri` to pull from. v2-only.
//
// The delegation sub-paths are built from the registries backend's own base +
// list path, so they need no separate Resource entry in the adapter.

const DELEGATIONS = '/delegations';

export function registerRegistryTools(
  server: McpServer,
  rt: ToolRuntime
): void {
  const { jsonReply, callRestUrl, backendFor } = rt;

  // ECR delegation is a v2-only concept — v1 has no equivalent endpoint, so the
  // tools return a clean 501 notice there rather than calling a v1 path that
  // does not exist (mirrors list-endpoint-workers / stream-pod-logs).
  const delegationsV2OnlyNotice = (tool: string) => ({
    error: `${tool} is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.`,
    status: 501,
  });

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

  // ============== ECR DELEGATION TOOLS (v2-only) ==============

  // List ECR Delegations
  server.tool(
    'list-registry-delegations',
    'List your AWS ECR delegations — ECR repositories Runpod has been granted scoped pull access to, so private ECR images can be pulled without storing AWS credentials. Each entry includes the `dockerRegistryUri` to pull from. v2-only — returns a 501 notice on the v1 API. Paginated via limit/cursor.',
    listPaginationParams,
    { title: 'List registry delegations', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('registries');
      if (backend.version === 'v1') {
        return jsonReply(delegationsV2OnlyNotice('list-registry-delegations'));
      }
      // The response envelope is `{delegations:[…]}`, not the `{registries:[…]}`
      // that backend.unwrap expects for this resource, so read the key directly.
      const raw = (await callRestUrl(
        `${backend.base}${backend.list}${DELEGATIONS}`
      )) as Record<string, unknown> | undefined;
      const delegations = Array.isArray(raw?.delegations)
        ? raw.delegations
        : [];
      return capListResult(delegations, {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Create ECR Delegation
  server.tool(
    'create-registry-delegation',
    'Register an AWS ECR repository so Runpod can pull private images from it without stored credentials. Pass the repository ARN; the reply carries the `dockerRegistryUri`, resolved repository/tag, and AWS region. v2-only — returns a 501 notice on the v1 API. For a non-ECR private registry use create-container-registry-auth instead.',
    {
      resource: z
        .string()
        .min(1)
        .describe(
          'ECR resource ARN, e.g. "arn:aws:ecr:us-east-2:123456789012:repository/my-org/my-image"'
        ),
      name: z
        .string()
        .optional()
        .describe('Optional human-readable name for the delegation'),
    },
    { title: 'Create registry delegation', ...WRITE },
    async (params) => {
      const backend = backendFor('registries');
      if (backend.version === 'v1') {
        return jsonReply(delegationsV2OnlyNotice('create-registry-delegation'));
      }
      // CreateDelegationRequest is additionalProperties:false — send only the
      // two documented keys, and omit `name` entirely when unset rather than
      // sending null.
      const body: Record<string, unknown> = { resource: params.resource };
      if (params.name !== undefined) body.name = params.name;
      const result = await callRestUrl(
        `${backend.base}${backend.list}${DELEGATIONS}`,
        'POST',
        body
      );
      return jsonReply(result);
    }
  );

  // Revoke ECR Delegation
  server.tool(
    'delete-registry-delegation',
    "Revoke an AWS ECR delegation, withdrawing Runpod's pull access to that repository. Existing workers keep running; future pulls fail. v2-only — returns a 501 notice on the v1 API. This cannot be undone.",
    {
      delegationId: z
        .string()
        .describe(
          'ID of the delegation to revoke (from list-registry-delegations)'
        ),
    },
    { title: 'Revoke registry delegation', ...DESTRUCTIVE },
    async (params) => {
      const backend = backendFor('registries');
      if (backend.version === 'v1') {
        return jsonReply(delegationsV2OnlyNotice('delete-registry-delegation'));
      }
      const result = await callRestUrl(
        `${backend.base}${backend.list}${DELEGATIONS}/${encodeURIComponent(
          params.delegationId
        )}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );
}
