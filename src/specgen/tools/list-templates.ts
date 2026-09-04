// Curated tool overriding the generated listTemplates (excluded in
// generator-config.yaml): full template objects carry env maps and readmes
// that blow up LLM context, so this returns the identifying fields only.

import type { ToolContext } from '../context.js';
import type { CuratedTool } from '../server.js';

export const listTemplates: CuratedTool = {
  name: 'list-templates',
  description:
    'List templates visible to the account. Returns id, name, image, and ' +
    'serverless flag per template; use get-template for full detail.',
  inputSchema: { type: 'object', properties: {} },
  async handler(ctx: ToolContext) {
    const { data, error, response } = await ctx.sdk.GET('/v2/templates');
    if (error !== undefined)
      return { ok: false, status: response.status, payload: error };
    return {
      ok: true,
      status: response.status,
      payload: {
        templates: data.templates.map((template) => ({
          id: template.id,
          name: template.name,
          image: template.image,
          serverless: template.serverless,
        })),
      },
    };
  },
};
