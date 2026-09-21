// Curated tool overriding the generated listTemplates (excluded in
// generator-config.yaml): full template objects carry env maps and readmes
// that blow up LLM context, so this returns the identifying fields only.

import { restError } from '../clients/rest-result.js';
import type { ToolContext } from '../context.js';
import type { CuratedTool } from '../types.js';
import { readOnly } from './annotations.js';

export const listTemplates: CuratedTool = {
  name: 'list-templates',
  annotations: readOnly,
  description:
    'List templates visible to the account. Returns id, name, image, and ' +
    'serverless flag per template; use get-template for full detail.',
  inputSchema: { type: 'object', properties: {} },
  async handler(ctx: ToolContext) {
    const { data, error, response } = await ctx.sdk.GET('/v2/templates');
    if (!response.ok) return restError(response, error);
    if (!data || !Array.isArray(data.templates)) {
      return {
        ok: false,
        status: 502,
        payload: { error: 'The Runpod API returned no list data.' },
      };
    }
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
