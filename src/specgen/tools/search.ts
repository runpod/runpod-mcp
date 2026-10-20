// search-docs: semantic search over Runpod's documentation, curated support
// knowledge, blog and runpod.io site, through the runpod-assistant knowledge
// index (src/search/knowledge.ts).
//
// The tool takes its search function from the transport: the hosted server
// searches in-process with its service key (searchKnowledge); stdio calls the
// hosted POST /api/search with the caller's own key (hostedSearch). Registered
// only when a search function is configured, so a deployment without one does
// not list it.

import {
  MAX_QUERY_CHARS,
  MAX_SEARCH_LIMIT,
  parseSearchRequest,
  SEARCH_NAMESPACES,
  type SearchFn,
} from '../../search/knowledge.js';
import type { CuratedTool } from '../types.js';
import { readOnly } from './annotations.js';
import { badRequest } from './util.js';

export function createSearchDocsTool(search: SearchFn): CuratedTool {
  return {
    name: 'search-docs',
    title: 'Search docs',
    annotations: readOnly,
    recordedArguments: ['limit'],
    description:
      'Search Runpod documentation, curated support knowledge, the Runpod blog and runpod.io for passages that answer a question, for example "how do I attach a network volume to a Serverless endpoint". Returns ranked passages with their source URLs. Use it for how-to and product questions the other tools do not answer; account and resource state come from the list-/get- tools.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: MAX_QUERY_CHARS,
          description: 'The question, in natural language.',
        },
        namespaces: {
          type: 'array',
          items: { type: 'string', enum: [...SEARCH_NAMESPACES] },
          minItems: 1,
          description:
            'Sources to search: docs (docs.runpod.io), knowledge (curated support answers), blog, site (runpod.io pages). Default: docs, knowledge, blog.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: 'Most passages to return. Default 8.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    handler: async (ctx, args) => {
      const parsed = parseSearchRequest(args);
      if ('error' in parsed) return badRequest(parsed.error);
      const outcome = await search(parsed.request, ctx.apiKey);
      return {
        ok: outcome.status === 200,
        status: outcome.status,
        payload: outcome.body,
      };
    },
  };
}
