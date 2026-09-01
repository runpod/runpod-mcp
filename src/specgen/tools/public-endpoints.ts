// Curated list-public-endpoints tool. RunPod Public Endpoints (managed
// pay-per-use model APIs) have no REST home — the catalog is the public
// GraphQL query allAiApiPublicConfigs, served unauthenticated. Ported from
// the official MCP server (Apache-2.0, runpod/runpod-mcp).

import type { CuratedTool } from '../server.js';
import { listPaginationProperties, capList } from '../pagination.js';
import { ok, runTool } from './util.js';

interface PublicEndpointConfig {
  id: string;
  aiApiId: string;
  modelName: string;
  displayName: string;
  description: string | null;
  metadata: string | null;
  isLive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface PublicEndpointsResponse {
  allAiApiPublicConfigs: PublicEndpointConfig[];
}

// `metadata` is a JSON string carrying pricing and classification. Parsed
// defensively — a malformed value falls back to undefined fields.
interface PublicEndpointMetadata {
  cost?: number;
  owner?: string;
  source?: string;
  tag?: string;
  priceString?: string;
}

function parseMetadata(
  metadata: string | null | undefined
): PublicEndpointMetadata {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as PublicEndpointMetadata)
      : {};
  } catch {
    return {};
  }
}

export const listPublicEndpoints: CuratedTool = {
  name: 'list-public-endpoints',
  description:
    'List RunPod Public Endpoints — managed, pay-per-use model APIs (text, image, video, audio) that require no deployment. Public catalog, no auth required. Each result includes the endpointId to call with run-endpoint/runsync-endpoint (or via https://api.runpod.ai/v2/{endpointId}), the model name, modality, owner, and pricing. Only live endpoints are returned by default; set includeOffline:true to also list ones that are not currently live.',
  inputSchema: {
    type: 'object',
    properties: {
      ...listPaginationProperties,
      searchTerm: {
        type: 'string',
        description:
          "Case-insensitive search across display name, model name, endpoint id, description, owner, and tag (e.g. 'kimi', 'video', 'flux')",
      },
      modality: {
        type: 'string',
        description:
          "Filter by modality/category (the metadata source field, e.g. 'language', 'image', 'video', 'audio')",
      },
      owner: {
        type: 'string',
        description:
          "Filter by model owner (e.g. 'moonshot', 'minimax', 'google')",
      },
      includeOffline: {
        type: 'boolean',
        description:
          'Include endpoints that are not currently live (isLive:false). Default false — only live endpoints are listed.',
      },
    },
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const data = await ctx.graphql.public<PublicEndpointsResponse>(`
        query {
          allAiApiPublicConfigs {
            id
            aiApiId
            modelName
            displayName
            description
            metadata
            isLive
            createdAt
            updatedAt
          }
        }
      `);

      let configs = data.allAiApiPublicConfigs.map((c) => ({
        config: c,
        meta: parseMetadata(c.metadata),
      }));

      if (!args.includeOffline) {
        configs = configs.filter(({ config }) => config.isLive);
      }
      if (args.modality) {
        const term = String(args.modality).toLowerCase();
        configs = configs.filter(
          ({ meta }) => (meta.source ?? '').toLowerCase() === term
        );
      }
      if (args.owner) {
        const term = String(args.owner).toLowerCase();
        configs = configs.filter(
          ({ meta }) => (meta.owner ?? '').toLowerCase() === term
        );
      }
      if (args.searchTerm) {
        const term = String(args.searchTerm).toLowerCase();
        configs = configs.filter(({ config, meta }) =>
          [
            config.displayName,
            config.modelName,
            config.aiApiId,
            config.description,
            meta.owner,
            meta.tag,
            meta.source,
          ].some((field) => (field ?? '').toLowerCase().includes(term))
        );
      }

      // Stable, scannable order for the catalog.
      configs = [...configs].sort((a, b) =>
        a.config.displayName.localeCompare(b.config.displayName)
      );

      const result = configs.map(({ config, meta }) => ({
        endpointId: config.aiApiId,
        displayName: config.displayName,
        modelName: config.modelName,
        description: config.description,
        modality: meta.source,
        tag: meta.tag,
        owner: meta.owner,
        pricing: meta.priceString,
        isLive: config.isLive,
        baseUrl: `https://api.runpod.ai/v2/${config.aiApiId}`,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      }));

      return ok(
        capList(result, {
          limit: args.limit as number | undefined,
          cursor: args.cursor as string | undefined,
        })
      );
    }),
};
