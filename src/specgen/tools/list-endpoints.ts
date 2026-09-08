// Curated tool overriding the generated listEndpoints (excluded in
// specgen/generator-config.yaml): full endpoint objects carry env maps and
// requestUrls — six URLs per endpoint, all derivable from the id — which
// measured 56% of a real account's payload (~32k tokens for 61 endpoints).
// This returns the identifying fields, paginated; get-endpoint has the rest.

import { withRateLimitHint } from '../../_shared/rate-limit.js';
import type { ToolContext } from '../context.js';
import type { CuratedTool } from '../server.js';
import { capList, listPaginationProperties } from '../pagination.js';

export const listEndpoints: CuratedTool = {
  name: 'list-endpoints',
  description:
    'List serverless endpoints owned by the account (trimmed: id, name, image, ' +
    'compute config, worker counts, scaling, data centers per endpoint — env ' +
    'vars and request URLs are omitted; use get-endpoint for the full object). ' +
    'Returns a page; pass cursor=nextCursor for more.',
  inputSchema: {
    type: 'object',
    properties: { ...listPaginationProperties },
  },
  async handler(ctx: ToolContext, args) {
    const { data, error, response } = await ctx.sdk.GET('/v2/serverless');
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
    return {
      ok: true,
      status: response.status,
      payload: capList(trimmed, {
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      }),
    };
  },
};
