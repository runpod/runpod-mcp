// Curated tool overriding the generated listEndpoints (excluded in
// specgen/generator-config.yaml): full endpoint objects carry env maps and
// requestUrls — six URLs per endpoint, all derivable from the id — which
// measured 56% of a real account's payload (~32k tokens for 61 endpoints).
// This returns the identifying fields, paginated; get-endpoint has the rest.

import { restError } from '../clients/rest-result.js';
import type { ToolContext } from '../context.js';
import { generatedRowSchemas } from '../generated/tools.gen.js';
import {
  compileListQuery,
  listJmespathProperty,
  pickFields,
} from '../list-query.js';
import type { CuratedTool } from '../types.js';
import { listFromApi, listPaginationProperties } from '../pagination.js';
import { readOnly } from './annotations.js';

// What each row keeps; jmespath sees exactly these fields.
const FIELDS = [
  'id',
  'name',
  'type',
  'image',
  'gpu',
  'cpu',
  'workers',
  'scaling',
  'dataCenterIds',
  'flashboot',
  'createdAt',
] as const;
const ROW_SCHEMA = pickFields(generatedRowSchemas['list-endpoints'], FIELDS);

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
    properties: {
      ...listPaginationProperties(),
      jmespath: listJmespathProperty,
    },
  },
  rowSchema: ROW_SCHEMA,
  async handler(ctx: ToolContext, args) {
    const compiled = compileListQuery(args.jmespath, ROW_SCHEMA, 'endpoints');
    if (!compiled.ok) return compiled;
    let status = 200;
    const listed = await listFromApi(
      'list-endpoints',
      args,
      async (query) => {
        const { data, error, response } = await ctx.sdk.GET('/v2/serverless', {
          params: { query },
        });
        if (!response.ok)
          return { ...restError(response, error), ok: false as const };
        if (!data || !Array.isArray(data.endpoints))
          return {
            ok: false as const,
            status: 502,
            payload: { error: 'The Runpod API returned no list data.' },
          };
        status = response.status;
        return {
          ok: true as const,
          rows: data.endpoints.map((endpoint) =>
            Object.fromEntries(FIELDS.map((field) => [field, endpoint[field]]))
          ),
          api: data.pagination,
        };
      },
      (endpoints, pagination) => ({ endpoints, pagination }),
      undefined,
      compiled.query
    );
    return listed.ok ? { ok: true, status, payload: listed.payload } : listed;
  },
};
