// Curated tool overriding the generated listTemplates (excluded in
// generator-config.yaml): full template objects carry env maps and readmes
// that blow up LLM context, so this returns the identifying fields only.

import { withRateLimitHint } from '../../_shared/rate-limit.js';
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
    if (!response.ok) {
      const payload = error ?? {
        error: response.statusText || `HTTP ${response.status}`,
      };
      return {
        ok: false,
        status: response.status,
        payload:
          response.status === 429
            ? withRateLimitHint(
                typeof payload === 'object' && payload !== null
                  ? payload
                  : { error: payload },
                response.headers
              )
            : payload,
      };
    }
    if (!data) {
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
