import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, WRITE, DESTRUCTIVE, type ToolRuntime } from './runtime.js';

// ============== TAG MANAGEMENT TOOLS (v2-only) ==============
// Tags are key/value labels attachable to pods, network volumes, clusters, and
// serverless endpoints. The whole resource is v2-only: there is no v1 REST or
// GraphQL equivalent, so every tool returns a clean 501 notice on v1 (matching
// list-cpu-types / get-gpu-type).

// The resource types a tag can attach to (TagResourceType in the v2 spec).
const TAG_RESOURCE_TYPES = [
  'POD',
  'NETWORK_VOLUME',
  'CLUSTER',
  'SERVERLESS_ENDPOINT',
] as const;

const taggedResourceSchema = z.object({
  id: z.string().describe('Resource identifier (e.g. a pod or endpoint id)'),
  type: z
    .enum(TAG_RESOURCE_TYPES)
    .describe('Type of resource to associate with the tag'),
});

// Shared 501 reply for v1. Returned by every tag tool when not on v2.
function v2OnlyNotice(tool: string) {
  return {
    error: `${tool} is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.`,
    status: 501,
  };
}

export function registerTagTools(server: McpServer, rt: ToolRuntime): void {
  const { jsonReply, callRestUrl, backendFor } = rt;

  // List Tags
  server.tool(
    'list-tags',
    'List your tags (key/value labels on pods, volumes, clusters, and endpoints). v2-only — returns a 501 notice on the v1 API. Paginated via limit/cursor.',
    {
      ...listPaginationParams,
      includeResources: z
        .boolean()
        .optional()
        .describe('Include the resources attached to each tag in the response'),
    },
    { title: 'List tags', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('tags');
      if (backend.version === 'v1') return jsonReply(v2OnlyNotice('list-tags'));
      const query = params.includeResources ? '?include=resources' : '';
      const raw = await callRestUrl(`${backend.base}${backend.list}${query}`);
      return capListResult(backend.unwrap(raw), {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get Tag
  server.tool(
    'get-tag',
    'Get one tag by id, optionally including its attached resources. v2-only — returns a 501 notice on the v1 API.',
    {
      tagId: z.string().describe('ID of the tag to retrieve'),
      includeResources: z
        .boolean()
        .optional()
        .describe('Include the resources attached to this tag'),
    },
    { title: 'Get tag', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('tags');
      if (backend.version === 'v1') return jsonReply(v2OnlyNotice('get-tag'));
      const query = params.includeResources ? '?include=resources' : '';
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.tagId)}${query}`
      );
      return jsonReply(result);
    }
  );

  // Create Tag
  server.tool(
    'create-tag',
    'Create a key/value tag, optionally attaching resources at creation. v2-only — returns a 501 notice on the v1 API.',
    {
      key: z.string().min(1).describe('Tag key (e.g. "project")'),
      value: z.string().min(1).describe('Tag value (e.g. "gpt-training")'),
      resources: z
        .array(taggedResourceSchema)
        .optional()
        .describe('Resources to attach to the tag at creation time'),
    },
    { title: 'Create tag', ...WRITE },
    async (params) => {
      const backend = backendFor('tags');
      if (backend.version === 'v1')
        return jsonReply(v2OnlyNotice('create-tag'));
      const result = await callRestUrl(
        `${backend.base}${backend.list}`,
        'POST',
        params as Record<string, unknown>
      );
      return jsonReply(result);
    }
  );

  // Update Tag
  server.tool(
    'update-tag',
    'Update a tag (rename its key/value, or replace its resource associations). Provide at least one of key, value, or resources. Sending resources:[] removes all associations; omitting resources leaves them unchanged. Replacing resources is NOT atomic — a failed update can leave a partially-applied set, so for small association changes prefer attach-tag/detach-tag. v2-only — returns a 501 notice on the v1 API.',
    {
      tagId: z.string().describe('ID of the tag to update'),
      key: z.string().min(1).optional().describe('New tag key'),
      value: z.string().min(1).optional().describe('New tag value'),
      resources: z
        .array(taggedResourceSchema)
        .optional()
        .describe(
          "Replace the tag's resource associations with exactly these. Omit to leave unchanged; pass [] to detach all."
        ),
    },
    // No idempotentHint: replacing `resources` is non-atomic upstream, so a
    // retried-after-partial-failure update is not guaranteed to be a no-op.
    { title: 'Update tag', ...WRITE },
    async (params) => {
      const { tagId, ...updateParams } = params;
      const backend = backendFor('tags');
      if (backend.version === 'v1')
        return jsonReply(v2OnlyNotice('update-tag'));
      const result = await callRestUrl(
        `${backend.base}${backend.get!(tagId)}`,
        'PATCH',
        updateParams as Record<string, unknown>
      );
      return jsonReply(result);
    }
  );

  // Delete Tag
  server.tool(
    'delete-tag',
    'Permanently delete a tag (removes it from all resources it is attached to). This cannot be undone. v2-only — returns a 501 notice on the v1 API.',
    {
      tagId: z.string().describe('ID of the tag to delete'),
    },
    { title: 'Delete tag', ...DESTRUCTIVE },
    async (params) => {
      const backend = backendFor('tags');
      if (backend.version === 'v1')
        return jsonReply(v2OnlyNotice('delete-tag'));
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.tagId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );

  // Attach Tag to a Resource
  server.tool(
    'attach-tag',
    'Attach a tag to a resource (pod, network volume, cluster, or serverless endpoint). Idempotent — attaching an already-associated resource is a no-op. v2-only — returns a 501 notice on the v1 API.',
    {
      tagId: z.string().describe('ID of the tag'),
      resourceType: z
        .enum(TAG_RESOURCE_TYPES)
        .describe('Type of resource to attach the tag to'),
      resourceId: z
        .string()
        .describe('ID of the resource to attach the tag to'),
    },
    { title: 'Attach tag to resource', ...WRITE, idempotentHint: true },
    async (params) => {
      const backend = backendFor('tags');
      if (backend.version === 'v1')
        return jsonReply(v2OnlyNotice('attach-tag'));
      const result = await callRestUrl(
        `${backend.base}/tags/${params.tagId}/resources/${params.resourceType}/${params.resourceId}`,
        'PUT'
      );
      return jsonReply(result);
    }
  );

  // Detach Tag from a Resource
  server.tool(
    'detach-tag',
    'Detach a tag from a resource (removes the association only — the resource and tag are not deleted). Idempotent — detaching a resource that is not associated is a no-op. v2-only — returns a 501 notice on the v1 API.',
    {
      tagId: z.string().describe('ID of the tag'),
      resourceType: z
        .enum(TAG_RESOURCE_TYPES)
        .describe('Type of resource to detach the tag from'),
      resourceId: z
        .string()
        .describe('ID of the resource to detach the tag from'),
    },
    { title: 'Detach tag from resource', ...WRITE, idempotentHint: true },
    async (params) => {
      const backend = backendFor('tags');
      if (backend.version === 'v1')
        return jsonReply(v2OnlyNotice('detach-tag'));
      const result = await callRestUrl(
        `${backend.base}/tags/${params.tagId}/resources/${params.resourceType}/${params.resourceId}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );
}
