// Curated Hub tools. The Hub catalog and Hub deploys have no REST home: the
// catalog is the public GraphQL `listings(input: {})` query, and a deploy is
// the authenticated saveEndpoint mutation pinned to a hubReleaseId. Ported
// from the official MCP server (Apache-2.0, runpod/runpod-mcp).

import type { CuratedTool } from '../server.js';
import { listPaginationProperties, capList } from '../pagination.js';
import type { ToolResult } from '../dispatch.js';
import { badRequest, ok, runTool } from './util.js';

interface HubBuild {
  id: string;
  imageName: string;
}

interface HubRelease {
  id: string;
  name: string;
  tagName: string;
  createdAt: string;
  config?: string | null;
  build?: HubBuild | null;
}

interface HubListing {
  id: string;
  repoId: string;
  title: string;
  description: string | null;
  repoName: string;
  repoOwner: string;
  createdAt: string;
  updatedAt: string;
  views: number;
  stars: number;
  deploys: number;
  language: string | null;
  category: string | null;
  tags: string[] | null;
  type: string;
  listedRelease?: HubRelease | null;
}

interface ListingsResponse {
  listings: HubListing[];
}

// The release `config` is the repo's .runpod/hub.json serialized as a JSON
// string (hardware requirements + env-var input schema). Tens of KB per
// listing, so it is only requested when needed.
function parseReleaseConfig(config: string | null | undefined): unknown {
  if (!config) return undefined;
  try {
    return JSON.parse(config);
  } catch {
    return config;
  }
}

interface HubReleaseConfig {
  runsOn?: string;
  containerDiskInGb?: number;
  gpuIds?: string;
  gpuCount?: number;
  allowedCudaVersions?: string[];
  env?: Array<{
    key: string;
    input?: {
      name?: string;
      type?: string;
      default?: unknown;
      required?: boolean;
      trueValue?: string;
      falseValue?: string;
    };
  }>;
}

// The one listings query both hub tools share. `withConfig` pulls in the
// (large) release config only when the caller needs it.
function listingsQuery(withConfig: boolean): string {
  return `
    query {
      listings(input: {}) {
        id
        repoId
        title
        description
        repoName
        repoOwner
        createdAt
        updatedAt
        views
        stars
        deploys
        language
        category
        tags
        type
        listedRelease {
          id
          name
          tagName
          createdAt${withConfig ? '\n          config' : ''}
          build {
            id
            imageName
          }
        }
      }
    }
  `;
}

// Serializes a boolean through the schema's trueValue/falseValue. Applied to
// caller values too: an agent naturally passes 'true' where the schema
// declares trueValue '1'. Only exact 'true'/'false' map; anything else is a
// deliberate literal.
function serializeBoolean(
  value: string,
  input: { type?: string; trueValue?: string; falseValue?: string }
): string {
  if (value === 'true') return input.trueValue ?? 'true';
  if (value === 'false') return input.falseValue ?? 'false';
  return value;
}

// Builds the template env array a Hub deploy submits: every key from the
// release's env schema with its default (booleans serialized through
// trueValue/falseValue), overridden by caller values. Caller keys not in the
// schema are appended verbatim. Returns the missing required keys so the tool
// can fail with an actionable message instead of a broken endpoint.
export function buildHubEnv(
  config: HubReleaseConfig,
  overrides: Record<string, string>
): { env: Array<{ key: string; value: string }>; missingRequired: string[] } {
  const env: Array<{ key: string; value: string }> = [];
  const missingRequired: string[] = [];
  const remaining = { ...overrides };

  for (const entry of config.env ?? []) {
    const input = entry.input ?? {};
    const override = entry.key in remaining ? remaining[entry.key] : undefined;
    delete remaining[entry.key];

    // An override present but EMPTY is not a value — an empty string must not
    // satisfy a required key (it would deploy a broken worker).
    if (override !== undefined && override !== '') {
      env.push({
        key: entry.key,
        value:
          input.type === 'boolean'
            ? serializeBoolean(override, input)
            : override,
      });
      continue;
    }

    if (input.default !== undefined && input.default !== null) {
      env.push({
        key: entry.key,
        value:
          typeof input.default === 'boolean'
            ? input.default
              ? (input.trueValue ?? 'true')
              : (input.falseValue ?? 'false')
            : String(input.default),
      });
      continue;
    }

    if (input.required) {
      missingRequired.push(entry.key);
      env.push({ key: entry.key, value: '' });
      continue;
    }

    // Optional, no default, nothing supplied: OMIT the key rather than send ''
    // (os.environ.get('X', 'fallback') returns '' when X='', shadowing the
    // fallback).
  }

  for (const [key, value] of Object.entries(remaining)) {
    env.push({ key, value });
  }

  return { env, missingRequired };
}

// Lowest entry of the config's allowedCudaVersions (numeric-aware compare, so
// '12.10' > '12.9'). The console submits this as minCudaVersion.
export function minCudaVersion(versions: string[] | undefined): string | null {
  if (!versions || versions.length === 0) return null;
  const compare = (a: string, b: string) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  return [...versions].sort(compare)[0];
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export const listHubRepos: CuratedTool = {
  name: 'list-hub-repos',
  description:
    'List repos published to the RunPod Hub (prebuilt Serverless workers and Pod templates, e.g. vLLM, ComfyUI). Public catalog — no auth required. Each result includes the currently listed release with its hubReleaseId and prebuilt image name. Results are sorted by deploy count (most popular first). Set includeConfig:true to also return the release config (hardware requirements and environment-variable schema) — it is large, so prefer requesting it for a single repo via the repoOwner/searchTerm filters.',
  inputSchema: {
    type: 'object',
    properties: {
      ...listPaginationProperties,
      searchTerm: {
        type: 'string',
        description:
          "Case-insensitive search across title, description, repo name, owner, and tags (e.g. 'vllm', 'comfyui', 'fine-tuning')",
      },
      category: {
        type: 'string',
        description:
          "Filter by category (e.g. 'language', 'image', 'audio', 'video', 'embedding')",
      },
      type: {
        type: 'string',
        enum: ['SERVERLESS', 'POD'],
        description:
          'Filter by listing type: SERVERLESS (endpoint workers) or POD (pod templates)',
      },
      repoOwner: {
        type: 'string',
        description:
          "Filter to listings from this GitHub owner/org (e.g. 'runpod-workers', 'axolotl-ai-cloud')",
      },
      includeConfig: {
        type: 'boolean',
        description:
          'Include the listed release config (hardware requirements + env-var input schema, parsed from .runpod/hub.json). Large — off by default.',
      },
    },
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const data = await ctx.graphql.public<ListingsResponse>(
        listingsQuery(args.includeConfig === true)
      );

      let listings = data.listings ?? [];

      if (args.type) {
        // Normalize the arg too: the server never validates inputSchema, so a
        // lowercase "serverless" must match, not return a silent empty page.
        const term = String(args.type).toUpperCase();
        listings = listings.filter(
          (l) => (l.type ?? '').toUpperCase() === term
        );
      }
      if (args.category) {
        const term = String(args.category).toLowerCase();
        listings = listings.filter(
          (l) => (l.category ?? '').toLowerCase() === term
        );
      }
      if (args.repoOwner) {
        const term = String(args.repoOwner).toLowerCase();
        listings = listings.filter(
          (l) => (l.repoOwner ?? '').toLowerCase() === term
        );
      }
      if (args.searchTerm) {
        const term = String(args.searchTerm).toLowerCase();
        listings = listings.filter((l) =>
          [
            l.title,
            l.description,
            l.repoName,
            l.repoOwner,
            ...(l.tags ?? []),
          ].some((field) => (field ?? '').toLowerCase().includes(term))
        );
      }

      // Most-deployed first, id as tiebreak. The tiebreak is load-bearing:
      // each page re-fetches the whole catalog and the query promises no
      // order, so ties would move between requests and paging would silently
      // skip and duplicate.
      listings = [...listings].sort(
        (a, b) =>
          (b.deploys ?? 0) - (a.deploys ?? 0) || a.id.localeCompare(b.id)
      );

      const result = listings.map((l) => ({
        id: l.id,
        repo: `${l.repoOwner}/${l.repoName}`,
        title: l.title,
        description: l.description,
        type: l.type,
        category: l.category,
        tags: l.tags,
        language: l.language,
        stars: l.stars,
        deploys: l.deploys,
        views: l.views,
        githubUrl: `https://github.com/${l.repoOwner}/${l.repoName}`,
        hubUrl: `https://console.runpod.io/hub/${l.repoOwner}/${l.repoName}`,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        listedRelease: l.listedRelease
          ? {
              hubReleaseId: l.listedRelease.id,
              name: l.listedRelease.name,
              tagName: l.listedRelease.tagName,
              createdAt: l.listedRelease.createdAt,
              imageName: l.listedRelease.build?.imageName,
              ...(args.includeConfig === true
                ? { config: parseReleaseConfig(l.listedRelease.config) }
                : {}),
            }
          : null,
      }));

      return ok(
        capList(result, {
          limit: args.limit as number | undefined,
          cursor: args.cursor as string | undefined,
        })
      );
    }),
};

export const deployHubRepo: CuratedTool = {
  name: 'deploy-hub-repo',
  description:
    "Deploy a RunPod Hub repo's listed release as a new Serverless endpoint (the same as clicking Deploy on the Hub). Identify the repo by `repo` (\"owner/name\" from list-hub-repos) or by `hubReleaseId`. The release supplies the prebuilt image, container disk, CUDA constraints, and env-var defaults; pass `env` to override or fill in values (required keys without a default must be provided — check list-hub-repos with includeConfig:true for the schema). GPU selection comes from the release config when it specifies one; otherwise pass gpuIds (GPU pool names, e.g. 'ADA_24' or 'ADA_80_PRO,AMPERE_80'). Uses the authenticated GraphQL API (no REST home for Hub deploys yet).",
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description:
          'The Hub repo to deploy as "owner/name" (e.g. \'runpod-workers/worker-comfyui\'). Deploys its currently listed release. Provide this or hubReleaseId.',
      },
      hubReleaseId: {
        type: 'string',
        description:
          'The Hub release ID to deploy (from list-hub-repos listedRelease.hubReleaseId). Provide this or repo.',
      },
      name: {
        type: 'string',
        description:
          "Name for the new endpoint. Defaults to '<listing title> <release tag>'.",
      },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Environment variable overrides, merged over the release config defaults. Keys not in the release schema are passed through as-is.',
      },
      gpuIds: {
        type: 'string',
        description:
          "Comma-separated GPU pool names for workers (e.g. 'ADA_24' or 'ADA_80_PRO,AMPERE_80'). To pin specific GPU SKUs within a pool, append exclusions prefixed with '-' using GPU type ids from list-gpu-types. Defaults to the release config's gpuIds; required when the config does not specify one.",
      },
      gpuCount: {
        type: 'integer',
        minimum: 1,
        description: 'GPUs per worker. Defaults to the release config (or 1).',
      },
      containerDiskInGb: {
        type: 'integer',
        minimum: 1,
        description:
          'Container disk size in GB. Defaults to the release config.',
      },
      workersMin: {
        type: 'integer',
        minimum: 0,
        description: 'Minimum workers (default 0 — scale to zero).',
      },
      workersMax: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum workers (default: account default).',
      },
      idleTimeout: {
        type: 'integer',
        minimum: 1,
        description: 'Seconds a worker idles before scaling down (default 5).',
      },
      scalerType: {
        type: 'string',
        enum: ['QUEUE_DELAY', 'REQUEST_COUNT'],
        description: 'Autoscaler type (default QUEUE_DELAY).',
      },
      scalerValue: {
        type: 'number',
        description: 'Autoscaler target value (default 4).',
      },
      executionTimeoutMs: {
        type: 'integer',
        minimum: 1,
        description: 'Per-job execution timeout in ms (default 600000).',
      },
      flashboot: {
        type: 'string',
        enum: ['OFF', 'FLASHBOOT', 'PRIORITY_FLASHBOOT'],
        description: 'FlashBoot mode (default FLASHBOOT).',
      },
    },
  },
  handler: (ctx, args) =>
    runTool(async () => {
      if (!args.repo && !args.hubReleaseId) {
        return badRequest(
          'Provide either repo ("owner/name") or hubReleaseId. Use list-hub-repos to discover both.'
        );
      }
      const catalog = await ctx.graphql.public<ListingsResponse>(
        listingsQuery(true)
      );
      const listing = resolveListing(catalog, args);
      if ('payload' in listing) return listing;
      const release = checkDeployable(listing);
      if ('payload' in release) return release;
      const built = buildEndpointInput(listing, release, args);
      if ('payload' in built) return built;
      const data = await ctx.graphql.authed<SaveEndpointResponse>(
        SAVE_ENDPOINT_MUTATION,
        { input: built.input }
      );
      return ok({
        endpoint: data.saveEndpoint,
        deployed: {
          repo: `${listing.repoOwner}/${listing.repoName}`,
          release: release.tagName,
          hubReleaseId: release.id,
          imageName: release.build!.imageName,
        },
        note: `Endpoint created. Submit jobs with run-endpoint/runsync-endpoint using endpointId "${data.saveEndpoint.id}".`,
      });
    }),
};

// ---- deploy-hub-repo helpers. Each returns its value or a ToolResult error
// (discriminated by the `payload` key, which only ToolResult carries) so the
// handler reads as the sequence of steps it is.

type DeployListedRelease = NonNullable<HubListing['listedRelease']>;

// Resolve the listing from the public catalog. The catalog only exposes each
// repo's currently LISTED release, so a hubReleaseId must match one of those
// (also the only state the console deploys).
function resolveListing(
  catalog: ListingsResponse,
  args: Record<string, unknown>
): HubListing | ToolResult {
  let listing: HubListing | undefined;
  if (args.hubReleaseId) {
    listing = (catalog.listings ?? []).find(
      (l) => l.listedRelease?.id === args.hubReleaseId
    );
  } else {
    const repoKey = String(args.repo).toLowerCase();
    listing = (catalog.listings ?? []).find(
      (l) => `${l.repoOwner}/${l.repoName}`.toLowerCase() === repoKey
    );
  }
  if (!listing) {
    return badRequest(
      `No Hub listing found for ${
        args.hubReleaseId
          ? `hubReleaseId "${args.hubReleaseId}" (only each repo's currently listed release is deployable)`
          : `repo "${args.repo}"`
      }. Use list-hub-repos to see the catalog.`
    );
  }
  return listing;
}

function checkDeployable(
  listing: HubListing
): DeployListedRelease | ToolResult {
  const release = listing.listedRelease;
  if (!release?.build?.imageName) {
    return badRequest(
      `Hub repo ${listing.repoOwner}/${listing.repoName} has no listed release with a built image, so it cannot be deployed.`
    );
  }
  if ((listing.type ?? '').toUpperCase() !== 'SERVERLESS') {
    return badRequest(
      `Hub repo ${listing.repoOwner}/${listing.repoName} is a ${listing.type} listing — only SERVERLESS listings deploy as endpoints.`
    );
  }
  return release;
}

function buildEndpointInput(
  listing: HubListing,
  release: DeployListedRelease,
  args: Record<string, unknown>
): { input: Record<string, unknown> } | ToolResult {
  const config = (parseReleaseConfig(release.config) ?? {}) as HubReleaseConfig;

  const gpuIds = (args.gpuIds as string | undefined) ?? config.gpuIds;
  if (!gpuIds) {
    return badRequest(
      'This release does not specify a GPU pool — pass gpuIds (comma-separated pool names, e.g. "ADA_80_PRO,AMPERE_80"; see the pool field on list-gpu-types).'
    );
  }

  const { env, missingRequired } = buildHubEnv(
    config,
    (args.env as Record<string, string> | undefined) ?? {}
  );
  if (missingRequired.length > 0) {
    return badRequest(
      `Missing required environment variables for this release: ${missingRequired.join(', ')}. Pass them via the env parameter.`
    );
  }

  const endpointName =
    (args.name as string | undefined) ?? `${listing.title} ${release.tagName}`;
  const minCuda = minCudaVersion(config.allowedCudaVersions);

  return {
    input: {
      name: endpointName,
      hubReleaseId: release.id,
      type: 'QB',
      gpuIds,
      gpuCount: (args.gpuCount as number | undefined) ?? config.gpuCount ?? 1,
      workersMin: (args.workersMin as number | undefined) ?? 0,
      workersMax: (args.workersMax as number | undefined) ?? null,
      idleTimeout: (args.idleTimeout as number | undefined) ?? 5,
      scalerType: (args.scalerType as string | undefined) ?? 'QUEUE_DELAY',
      scalerValue: (args.scalerValue as number | undefined) ?? 4,
      executionTimeoutMs:
        (args.executionTimeoutMs as number | undefined) ?? 600000,
      flashBootType: (args.flashboot as string | undefined) ?? 'FLASHBOOT',
      locations: null,
      networkVolumeIds: null,
      compliance: [],
      modelReferences: [],
      ...(minCuda
        ? {
            minCudaVersion: minCuda,
            allowedCudaVersions: config.allowedCudaVersions!.join(','),
          }
        : {}),
      template: {
        name: `${endpointName}__template__${randomSuffix()}`,
        imageName: release.build!.imageName,
        containerDiskInGb:
          (args.containerDiskInGb as number | undefined) ??
          config.containerDiskInGb ??
          20,
        containerRegistryAuthId: '',
        dockerArgs: '',
        startScript: '',
        ports: '',
        env,
      },
    },
  };
}

interface SaveEndpointResponse {
  saveEndpoint: {
    id: string;
    name: string;
    gpuIds: string;
    gpuCount: number;
    workersMin: number;
    workersMax: number | null;
    idleTimeout: number;
    scalerType: string;
    scalerValue: number;
    flashBootType: string;
    templateId: string;
  };
}

const SAVE_ENDPOINT_MUTATION = `
  mutation saveEndpoint($input: EndpointInput!) {
    saveEndpoint(input: $input) {
      id
      name
      gpuIds
      gpuCount
      workersMin
      workersMax
      idleTimeout
      scalerType
      scalerValue
      flashBootType
      templateId
    }
  }
`;

export const hubTools: CuratedTool[] = [listHubRepos, deployHubRepo];
