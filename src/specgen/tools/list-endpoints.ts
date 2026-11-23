// Curated tool overriding the generated listEndpoints (excluded in
// specgen/generator-config.yaml): full endpoint objects carry env maps and
// requestUrls — six URLs per endpoint, all derivable from the id — which
// measured 56% of a real account's payload (~32k tokens for 61 endpoints).
// This returns the identifying fields, paginated; get-endpoint has the rest.

import { restError } from '../clients/rest-result.js';
import type { ToolContext } from '../context.js';
import type { CuratedTool } from '../types.js';
import {
  listPaginationProperties,
  pageFromApi,
  apiPageRequest,
} from '../pagination.js';
import { readOnly } from './annotations.js';

export const listEndpoints: CuratedTool = {
  name: 'list-endpoints',
  title: 'List endpoints',
  directoryDescription:
    'List the Serverless endpoints the account owns, trimmed to id, name, image, compute config, worker counts, scaling and data centers; environment variables and request URLs are left out.',
  annotations: readOnly,
  description:
    'List serverless endpoints owned by the account (trimmed: id, name, image, ' +
    'compute config, worker counts, scaling, data centers per endpoint — env ' +
    'vars and request URLs are omitted; use get-endpoint for the full object).',
  inputSchema: {
    type: 'object',
    properties: { ...listPaginationProperties() },
  },
  async handler(ctx: ToolContext, args) {
    const request = apiPageRequest('list-endpoints', args);
    if (!request.ok) return request;
    const { data, error, response } = await ctx.sdk.GET('/v2/serverless', {
      params: { query: request.query },
    });
    if (!response.ok) return restError(response, error);
    if (!data || !Array.isArray(data.endpoints)) {
      return {
        ok: false,
        status: 502,
        payload: { error: 'The Runpod API returned no list data.' },
      };
    }
    const trimmed = data.endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      type: endpoint.type,
      image: endpoint.image,
      gpu: endpoint.gpu,
      cpu: endpoint.cpu,
      workers: endpoint.workers,
      scaling: endpoint.scaling,
      dataCenterIds: endpoint.dataCenterIds,
      flashboot: endpoint.flashboot,
      createdAt: endpoint.createdAt,
    }));
    const listed = pageFromApi(
      trimmed,
      data.pagination,
      request,
      (endpoints, pagination) => ({ endpoints, pagination })
    );
    return listed.ok
      ? { ok: true, status: response.status, payload: listed.payload }
      : listed;
  },
};
