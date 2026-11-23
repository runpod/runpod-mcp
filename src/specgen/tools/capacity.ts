// Curated get-capacity tool. The per-CUDA-version stock matrix, graded stock,
// and per-version pricing live only in GraphQL (gpuTypes.lowestPrice with
// gpuTypeCudaVersions / allowedCudaVersions input) — the REST catalog's only
// CUDA dimension is a floor filter — so this cannot be generated from the v2
// spec. Ported from the official MCP server (Apache-2.0, runpod/runpod-mcp).
// Credential-free: served by the public GraphQL endpoint.

import type { ToolContext } from '../context.js';
import type { CuratedTool } from '../types.js';
import {
  cursorError,
  listPaginationProperties,
  pageInMemory,
} from '../pagination.js';
import { badRequest, ok, runTool } from './util.js';
import { readOnly } from './annotations.js';

const CAPACITY_DEFAULT_LIMIT = 100;

const CUDA_VERSION_REGEX = /^\d{1,2}\.\d{1,2}$/;
const MAX_PROBE_VERSIONS = 12;

interface CapacityGpu {
  id: string;
  displayName: string;
  memoryInGb: number;
  secureCloud: boolean;
  communityCloud: boolean;
  securePrice?: number | null;
  communityPrice?: number | null;
  lowestPrice?: {
    stockStatus: string | null;
    uninterruptablePrice: number | null;
    gpuTypeCudaVersions?: Array<{
      cudaVersion: string;
      availability: string;
    }> | null;
  } | null;
}

interface CapacityResponse {
  gpuTypes: CapacityGpu[];
}

const stockPriority: Record<string, number> = { High: 3, Medium: 2, Low: 1 };

// Without secureCloudOnly, lowestPrice.uninterruptablePrice can be the
// Community price even for a GPU Community Cloud does not offer (A40 read
// 0.35 against a 0.59 Secure price), so the pod is billed above the quote.
// These per-cloud fields are each cloud's on-demand price for one GPU, null
// when that cloud does not offer the GPU.
function perCloudPrices(gpu: CapacityGpu) {
  const price = (offered: boolean, value: number | null | undefined) =>
    offered && typeof value === 'number' && value > 0 ? value : null;
  return {
    securePricePerGpuHr: price(gpu.secureCloud, gpu.securePrice),
    communityPricePerGpuHr: price(gpu.communityCloud, gpu.communityPrice),
  };
}

// The arguments both modes share, re-validated at runtime (the low-level
// server never validates inputSchema): gpuCount coerced to an int in [1,8],
// secureCloud a literal, blank filter entries dropped (a schema-bypassed [""]
// must not match the whole catalog).
interface CapacityQuery {
  gpuCount: number;
  secureArg: string;
  includeUnavailable: boolean;
  matchesFilter: (gpu: CapacityGpu) => boolean;
  /** The call's arguments: paging reads limit and cursor, and binds the
   *  cursor to the rest. */
  args: Record<string, unknown>;
}

function parseCapacityArgs(args: Record<string, unknown>): CapacityQuery {
  const filterTerms = ((args.gpuTypeIds as string[] | undefined) ?? [])
    .filter((t) => typeof t === 'string' && t.trim().length > 0)
    .map((t) => t.toLowerCase());
  return {
    gpuCount: Math.min(8, Math.max(1, Math.floor(Number(args.gpuCount)) || 1)),
    secureArg: args.secureCloudOnly ? ', secureCloud: true' : '',
    includeUnavailable: args.includeUnavailable !== false,
    matchesFilter: (gpu) => {
      if (filterTerms.length === 0) return true;
      const id = gpu.id.toLowerCase();
      const name = gpu.displayName.toLowerCase();
      return filterTerms.some(
        (term) => id.includes(term) || name.includes(term)
      );
    },
    args,
  };
}

// The one ranking both modes share: most versions in stock first, then the
// strongest stock grade, then memory; drop no-stock rows unless the caller
// asked to keep them (they sort last either way).
function rankByStock<T>(
  rows: T[],
  stats: (row: T) => {
    inStock: number;
    bestPriority: number;
    memoryGb: number;
  },
  includeUnavailable: boolean
): T[] {
  const kept = includeUnavailable
    ? rows
    : rows.filter((row) => stats(row).inStock > 0);
  return kept.sort((a, b) => {
    const sa = stats(a);
    const sb = stats(b);
    return (
      sb.inStock - sa.inStock ||
      sb.bestPriority - sa.bestPriority ||
      sb.memoryGb - sa.memoryGb
    );
  });
}

export const getCapacity: CuratedTool = {
  name: 'get-capacity',
  title: 'Get GPU capacity by CUDA version',
  directoryDescription:
    'GPU capacity across host CUDA versions, as a matrix. By default one call returns, for each GPU type, overall stock plus AVAILABLE or UNAVAILABLE per host CUDA version. With cudaVersions it checks each listed version and returns graded stock (High, Medium, Low, Out) and the lowest on-demand price per version; a check that fails transiently reports an error for that version only. Out-of-stock GPUs are included unless includeUnavailable is false. Live public catalog data, so page cursors can shift between calls.',
  annotations: readOnly,
  description:
    "GPU capacity across host CUDA versions, as a matrix. Use this to choose an endpoint's allowedCudaVersions/minCudaVersion (or diagnose/widen a capacity-starved one) and to distinguish capacity problems from compatibility problems. Default mode is one call returning, per GPU type, overall stock plus AVAILABLE/UNAVAILABLE per host-reported CUDA version. Pass cudaVersions to deep-probe instead: one stock lookup per listed version, returning graded stock (High/Medium/Low/Out) and the lowest on-demand price per version; a probe that fails transiently reports a per-version error instead of failing the call. Nothing is hidden by default — set includeUnavailable:false to drop GPUs with no stock on any listed version. pricePerHr is the cheapest across both clouds unless secureCloudOnly; quote securePricePerGpuHr or communityPricePerGpuHr (null if that cloud lacks the GPU) for the cloud you create in. Credential-free public catalog data. Stock is live, so page cursors can shift between calls.",
  inputSchema: {
    type: 'object',
    properties: {
      // A small catalog agents compare across ("cheapest GPU in stock"):
      // the whole list by default; the byte budget still bounds the page.
      ...listPaginationProperties(CAPACITY_DEFAULT_LIMIT),
      cudaVersions: {
        type: 'array',
        items: { type: 'string', pattern: '^\\d{1,2}\\.\\d{1,2}$' },
        minItems: 1,
        maxItems: MAX_PROBE_VERSIONS,
        description:
          'Deep-probe these host CUDA versions (e.g. ["12.8", "13.0"], max 12): one stock lookup per version returns graded stock and price. Omit for the single-call AVAILABLE/UNAVAILABLE matrix across all versions the fleet currently reports.',
      },
      includeUnavailable: {
        type: 'boolean',
        description:
          'Out-of-stock GPUs are included by default (explicit "Out" cells / all-UNAVAILABLE rows, sorted last). Set false to hide GPUs with no stock on any listed version.',
      },
      gpuTypeIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Filter to GPU types matching any of these ids or display names (case-insensitive substring, e.g. ['NVIDIA GeForce RTX 4090'] or ['4090', 'H200']).",
      },
      gpuCount: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
        description: 'GPUs per worker/pod to check stock for (default 1).',
      },
      secureCloudOnly: {
        type: 'boolean',
        description: 'Restrict the stock lookup to Secure Cloud hosts.',
      },
    },
  },
  // A bad cursor is rejected before up to 12 capacity queries run.
  handler: async (ctx, args) =>
    cursorError('get-capacity', args) ??
    runTool(() => {
      const query = parseCapacityArgs(args);
      const cudaVersions = args.cudaVersions as string[] | undefined;
      return cudaVersions?.length
        ? probeMode(ctx, query, cudaVersions)
        : matrixMode(ctx, query);
    }),
};

// Matrix mode: one query, per-version AVAILABLE/UNAVAILABLE from the fleet.
async function matrixMode(ctx: ToolContext, query: CapacityQuery) {
  // The public GraphQL path takes no variables, so arguments are inlined —
  // every inlined value was re-validated in parseCapacityArgs.
  const data = await ctx.graphql.public<CapacityResponse>(`
    query {
      gpuTypes {
        id
        displayName
        memoryInGb
        secureCloud
        communityCloud
        securePrice
        communityPrice
        lowestPrice(input: { gpuCount: ${query.gpuCount}${query.secureArg} }) {
          stockStatus
          uninterruptablePrice
          gpuTypeCudaVersions {
            cudaVersion
            availability
          }
        }
      }
    }
  `);
  const rows = (data.gpuTypes ?? [])
    .filter((gpu) => gpu.id !== 'unknown' && query.matchesFilter(gpu))
    .map((gpu) => {
      const cuda: Record<string, string> = {};
      for (const c of gpu.lowestPrice?.gpuTypeCudaVersions ?? []) {
        cuda[c.cudaVersion] = c.availability;
      }
      return {
        id: gpu.id,
        displayName: gpu.displayName,
        memoryGb: gpu.memoryInGb,
        secureCloud: gpu.secureCloud,
        communityCloud: gpu.communityCloud,
        stockStatus: gpu.lowestPrice?.stockStatus || 'unavailable',
        pricePerHr: gpu.lowestPrice?.uninterruptablePrice ?? null,
        ...perCloudPrices(gpu),
        cudaVersions: cuda,
      };
    });
  const ranked = rankByStock(
    rows,
    (r) => ({
      inStock: Object.values(r.cudaVersions).filter((a) => a === 'AVAILABLE')
        .length,
      bestPriority: stockPriority[r.stockStatus] || 0,
      memoryGb: r.memoryGb,
    }),
    query.includeUnavailable
  );
  const listed = pageInMemory(
    'get-capacity',
    ranked,
    query.args,
    (gpus, pagination) => ({ gpus, pagination }),
    CAPACITY_DEFAULT_LIMIT
  );
  return listed.ok ? ok(listed.payload) : listed;
}

interface ProbeRow {
  id: string;
  displayName: string;
  memoryGb: number;
  secureCloud: boolean;
  communityCloud: boolean;
  securePricePerGpuHr: number | null;
  communityPricePerGpuHr: number | null;
  cudaVersions: Record<string, { stock: string; pricePerHr: number | null }>;
}

// Probe mode: one stock lookup per requested version, merged per GPU. The
// schema caps at 12, but the cap is re-enforced here because direct handler
// calls can bypass schema validation.
async function probeMode(
  ctx: ToolContext,
  query: CapacityQuery,
  cudaVersions: string[]
) {
  const versions = [...new Set(cudaVersions)].slice(0, MAX_PROBE_VERSIONS);
  const invalid = versions.filter((v) => !CUDA_VERSION_REGEX.test(v));
  if (invalid.length > 0) {
    return badRequest(
      `Invalid CUDA version format: ${invalid.join(', ')}. Use "major.minor" strings like "12.8".`
    );
  }
  // allSettled, not all: a transient failure on one probe must not discard
  // the other versions' results — failures land in probeErrors instead.
  const perVersion = await Promise.allSettled(
    versions.map((v) =>
      ctx.graphql.public<CapacityResponse>(`
        query {
          gpuTypes {
            id
            displayName
            memoryInGb
            secureCloud
            communityCloud
            securePrice
            communityPrice
            lowestPrice(input: { gpuCount: ${query.gpuCount}, allowedCudaVersions: ["${v}"]${query.secureArg} }) {
              stockStatus
              uninterruptablePrice
            }
          }
        }
      `)
    )
  );

  const probeErrors: Record<string, string> = {};
  const byId = new Map<string, ProbeRow>();
  versions.forEach((v, i) => {
    const settled = perVersion[i];
    if (settled.status === 'rejected') {
      probeErrors[v] =
        settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason);
      return;
    }
    for (const gpu of settled.value.gpuTypes ?? []) {
      if (gpu.id === 'unknown' || !query.matchesFilter(gpu)) continue;
      let row = byId.get(gpu.id);
      if (!row) {
        row = {
          id: gpu.id,
          displayName: gpu.displayName,
          memoryGb: gpu.memoryInGb,
          secureCloud: gpu.secureCloud,
          communityCloud: gpu.communityCloud,
          ...perCloudPrices(gpu),
          cudaVersions: {},
        };
        byId.set(gpu.id, row);
      }
      const stock = gpu.lowestPrice?.stockStatus;
      // No stockStatus means no hosts match this version at all — record
      // an explicit "Out" cell so starvation is visible rather than an
      // absence the agent has to infer.
      row.cudaVersions[v] =
        !stock || stock === 'Out'
          ? { stock: 'Out', pricePerHr: null }
          : {
              stock,
              pricePerHr: gpu.lowestPrice?.uninterruptablePrice ?? null,
            };
    }
  });

  const ranked = rankByStock(
    [...byId.values()],
    (r) => ({
      inStock: Object.values(r.cudaVersions).filter((c) => c.stock !== 'Out')
        .length,
      bestPriority: Math.max(
        0,
        ...Object.values(r.cudaVersions).map((c) => stockPriority[c.stock] || 0)
      ),
      memoryGb: r.memoryGb,
    }),
    query.includeUnavailable
  );
  const listed = pageInMemory(
    'get-capacity',
    ranked,
    query.args,
    (gpus, pagination) => ({
      probedCudaVersions: versions,
      ...(Object.keys(probeErrors).length > 0 ? { probeErrors } : {}),
      gpus,
      pagination,
    }),
    CAPACITY_DEFAULT_LIMIT
  );
  return listed.ok ? ok(listed.payload) : listed;
}
