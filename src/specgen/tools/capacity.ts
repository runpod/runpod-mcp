// Curated get-capacity tool. The per-CUDA-version stock matrix, graded stock,
// and per-version pricing live only in GraphQL (gpuTypes.lowestPrice with
// gpuTypeCudaVersions / allowedCudaVersions input) — the REST catalog's only
// CUDA dimension is a floor filter — so this cannot be generated from the v2
// spec. Ported from the official MCP server (Apache-2.0, runpod/runpod-mcp).
// Credential-free: served by the public GraphQL endpoint.

import type { CuratedTool } from '../server.js';
import { listPaginationProperties, capList } from '../pagination.js';
import { badRequest, ok, runTool } from './util.js';

const CUDA_VERSION_REGEX = /^\d{1,2}\.\d{1,2}$/;
const MAX_PROBE_VERSIONS = 12;

interface CapacityGpu {
  id: string;
  displayName: string;
  memoryInGb: number;
  secureCloud: boolean;
  communityCloud: boolean;
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

export const getCapacity: CuratedTool = {
  name: 'get-capacity',
  description:
    "GPU capacity across host CUDA versions, as a matrix. Use this to choose an endpoint's allowedCudaVersions/minCudaVersion (or diagnose/widen a capacity-starved one) and to distinguish capacity problems from compatibility problems. Default mode is one call returning, per GPU type, overall stock plus AVAILABLE/UNAVAILABLE per host-reported CUDA version. Pass cudaVersions to deep-probe instead: one stock lookup per listed version, returning graded stock (High/Medium/Low/Out) and the lowest on-demand price per version; a probe that fails transiently reports a per-version error instead of failing the call. Nothing is hidden by default — set includeUnavailable:false to drop GPUs with no stock on any listed version. Credential-free public catalog data. Stock is live, so page cursors can shift between calls.",
  inputSchema: {
    type: 'object',
    properties: {
      ...listPaginationProperties,
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
  handler: (ctx, args) =>
    runTool(async () => {
      // The public GraphQL path takes no variables, so arguments are inlined.
      // Every inlined value is re-validated at runtime, not just in the schema:
      // gpuCount coerced to an int in [1,8], cudaVersions regex-checked below,
      // secureCloud a literal.
      const gpuCount = Math.min(
        8,
        Math.max(1, Math.floor(Number(args.gpuCount)) || 1)
      );
      const secureArg = args.secureCloudOnly ? ', secureCloud: true' : '';

      // Blank/non-string filter entries are ignored (an all-blank list means
      // "no filter") — a schema-bypassed [""] must not match the whole catalog.
      const filterTerms = ((args.gpuTypeIds as string[] | undefined) ?? [])
        .filter((t) => typeof t === 'string' && t.trim().length > 0)
        .map((t) => t.toLowerCase());
      const matchesFilter = (gpu: CapacityGpu) => {
        if (filterTerms.length === 0) return true;
        const id = gpu.id.toLowerCase();
        const name = gpu.displayName.toLowerCase();
        return filterTerms.some(
          (term) => id.includes(term) || name.includes(term)
        );
      };

      const cudaVersions = args.cudaVersions as string[] | undefined;
      const pageOpts = {
        limit: args.limit as number | undefined,
        cursor: args.cursor as string | undefined,
      };

      // Matrix mode: one query, per-version availability from the fleet.
      if (!cudaVersions?.length) {
        const data = await ctx.graphql.public<CapacityResponse>(`
          query {
            gpuTypes {
              id
              displayName
              memoryInGb
              secureCloud
              communityCloud
              lowestPrice(input: { gpuCount: ${gpuCount}${secureArg} }) {
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
        let rows = (data.gpuTypes ?? [])
          .filter((gpu) => gpu.id !== 'unknown' && matchesFilter(gpu))
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
              cudaVersions: cuda,
            };
          });
        const availableCount = (r: (typeof rows)[number]) =>
          Object.values(r.cudaVersions).filter((a) => a === 'AVAILABLE').length;
        if (args.includeUnavailable === false)
          rows = rows.filter((r) => availableCount(r) > 0);
        rows.sort((a, b) => {
          const diff = availableCount(b) - availableCount(a);
          if (diff !== 0) return diff;
          const stockDiff =
            (stockPriority[b.stockStatus] || 0) -
            (stockPriority[a.stockStatus] || 0);
          if (stockDiff !== 0) return stockDiff;
          return b.memoryGb - a.memoryGb;
        });
        return ok(capList(rows, pageOpts));
      }

      // Probe mode: one stock lookup per requested version, merged per GPU.
      // The schema caps at 12, but the cap is re-enforced here because direct
      // handler calls can bypass schema validation.
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
                lowestPrice(input: { gpuCount: ${gpuCount}, allowedCudaVersions: ["${v}"]${secureArg} }) {
                  stockStatus
                  uninterruptablePrice
                }
              }
            }
          `)
        )
      );

      const probeErrors: Record<string, string> = {};
      interface ProbeRow {
        id: string;
        displayName: string;
        memoryGb: number;
        secureCloud: boolean;
        communityCloud: boolean;
        cudaVersions: Record<
          string,
          { stock: string; pricePerHr: number | null }
        >;
      }
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
          if (gpu.id === 'unknown' || !matchesFilter(gpu)) continue;
          let row = byId.get(gpu.id);
          if (!row) {
            row = {
              id: gpu.id,
              displayName: gpu.displayName,
              memoryGb: gpu.memoryInGb,
              secureCloud: gpu.secureCloud,
              communityCloud: gpu.communityCloud,
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

      let rows = [...byId.values()];
      const inStockCount = (r: ProbeRow) =>
        Object.values(r.cudaVersions).filter((c) => c.stock !== 'Out').length;
      if (args.includeUnavailable === false)
        rows = rows.filter((r) => inStockCount(r) > 0);
      rows.sort((a, b) => {
        const diff = inStockCount(b) - inStockCount(a);
        if (diff !== 0) return diff;
        const best = (r: ProbeRow) =>
          Math.max(
            0,
            ...Object.values(r.cudaVersions).map(
              (c) => stockPriority[c.stock] || 0
            )
          );
        const bestDiff = best(b) - best(a);
        if (bestDiff !== 0) return bestDiff;
        return b.memoryGb - a.memoryGb;
      });
      return ok(
        capList(rows, pageOpts, {
          probedCudaVersions: versions,
          ...(Object.keys(probeErrors).length > 0 ? { probeErrors } : {}),
        })
      );
    }),
};
