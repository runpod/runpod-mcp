import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, WRITE, DESTRUCTIVE, type ToolRuntime } from './runtime.js';

// ============== TEMPLATE MANAGEMENT TOOLS ==============

export function registerTemplateTools(
  server: McpServer,
  rt: ToolRuntime
): void {
  const { jsonReply, callRestUrl, backendFor } = rt;

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
    { title: 'List templates', ...READ_ONLY },
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
    'Get one template by id (image, env, ports, disk/volume config).',
    {
      templateId: z.string().describe('ID of the template to retrieve'),
    },
    { title: 'Get template', ...READ_ONLY },
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
    'Create a reusable pod/endpoint template (image, ports, env, disk/volume). On v2 a category is required and defaults to NVIDIA.',
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
    { title: 'Create template', ...WRITE },
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
    "Update a template's mutable fields (name, image, ports, env, readme). Only provided fields change.",
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
    { title: 'Update template', ...WRITE, idempotentHint: true },
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
    'Permanently delete a template. This cannot be undone.',
    {
      templateId: z.string().describe('ID of the template to delete'),
    },
    { title: 'Delete template', ...DESTRUCTIVE },
    async (params) => {
      const backend = backendFor('templates');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.templateId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );
}
