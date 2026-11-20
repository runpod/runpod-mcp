// Curated tool overriding the generated listTemplates (excluded in
// generator-config.yaml): full template objects carry env maps and readmes
// that blow up LLM context, so this returns the identifying fields only.

import { restError } from '../clients/rest-result.js';
import type { ToolContext } from '../context.js';
import type { CuratedTool } from '../types.js';
import {
  listPaginationProperties,
  pageFromApi,
  apiPageRequest,
} from '../pagination.js';
import { readOnly } from './annotations.js';

export const listTemplates: CuratedTool = {
  name: 'list-templates',
  title: 'List templates',
  directoryDescription:
    'List the templates visible to the account, with id, name, image and Serverless flag for each. A template missing from one page can be on a later one.',
  annotations: readOnly,
  description:
    'List templates visible to the account. Returns id, name, image, and ' +
    'serverless flag per template; use get-template for full detail. ' +
    'To find a template by name, follow pagination.nextCursor until ' +
    'hasNextPage is false: a name missing from one page may be on a later one.',
  inputSchema: {
    type: 'object',
    properties: { ...listPaginationProperties() },
  },
  async handler(ctx: ToolContext, args) {
    const request = apiPageRequest('list-templates', args);
    if (!request.ok) return request;
    const { data, error, response } = await ctx.sdk.GET('/v2/templates', {
      params: { query: request.query },
    });
    if (!response.ok) return restError(response, error);
    if (!data || !Array.isArray(data.templates)) {
      return {
        ok: false,
        status: 502,
        payload: { error: 'The Runpod API returned no list data.' },
      };
    }
    const listed = pageFromApi(
      data.templates.map((template) => ({
        id: template.id,
        name: template.name,
        image: template.image,
        serverless: template.serverless,
      })),
      data.pagination,
      request,
      (templates, pagination) => ({ templates, pagination })
    );
    return listed.ok
      ? { ok: true, status: response.status, payload: listed.payload }
      : listed;
  },
};
