// Curated tool overriding the generated listTemplates (excluded in
// generator-config.yaml): full template objects carry env maps and readmes
// that blow up LLM context, so this returns the identifying fields only.

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
const FIELDS = ['id', 'name', 'image', 'serverless'] as const;
const ROW_SCHEMA = pickFields(generatedRowSchemas['list-templates'], FIELDS);

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
    properties: {
      ...listPaginationProperties(),
      jmespath: listJmespathProperty,
    },
  },
  rowSchema: ROW_SCHEMA,
  async handler(ctx: ToolContext, args) {
    const compiled = compileListQuery(args.jmespath, ROW_SCHEMA, 'templates');
    if (!compiled.ok) return compiled;
    let status = 200;
    const listed = await listFromApi(
      'list-templates',
      args,
      async (query) => {
        const { data, error, response } = await ctx.sdk.GET('/v2/templates', {
          params: { query },
        });
        if (!response.ok)
          return { ...restError(response, error), ok: false as const };
        if (!data || !Array.isArray(data.templates))
          return {
            ok: false as const,
            status: 502,
            payload: { error: 'The Runpod API returned no list data.' },
          };
        status = response.status;
        return {
          ok: true as const,
          rows: data.templates.map((template) =>
            Object.fromEntries(FIELDS.map((field) => [field, template[field]]))
          ),
          api: data.pagination,
        };
      },
      (templates, pagination) => ({ templates, pagination }),
      undefined,
      compiled.query
    );
    return listed.ok ? { ok: true, status, payload: listed.payload } : listed;
  },
};
