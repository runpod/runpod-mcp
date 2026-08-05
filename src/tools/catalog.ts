import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { READ_ONLY, type ToolRuntime } from './runtime.js';

// ============== INFRASTRUCTURE / CATALOG TOOLS ==============
// GPU types, data centers, CPU types. v1 reads these over GraphQL; v2 has a REST
// catalog (GET /v2/catalog/*). The adapter picks the backend; v2-only entries
// return a 501 notice on v1.

export function registerCatalogTools(server: McpServer, rt: ToolRuntime): void {
  const { jsonReply, graphql, callRestUrl, backendFor } = rt;

  // List GPU Types
  server.tool(
    'list-gpu-types',
    'List available GPU types with stock/pricing and capability filters (minimum VRAM, secure/community cloud, name search). Use this to discover valid gpuTypeIds before creating a pod or endpoint. By default the full catalog is returned: each result includes an `availability` summary (HIGH/MEDIUM/LOW/NONE) and results are sorted with the most-available GPUs first, but nothing is hidden. Set includeUnavailable:false to drop out-of-stock GPUs and list only deployable ones (set includeAvailability:false to skip the stock lookup entirely). For per-datacenter availability (to pick a dataCenterIds), use get-gpu-type.',
    {
      ...listPaginationParams,
      minMemoryGb: z
        .number()
        .optional()
        .describe('Filter to GPUs with at least this much VRAM in GB'),
      secureCloudOnly: z
        .boolean()
        .optional()
        .describe('Filter to only GPUs available in secure cloud'),
      communityCloudOnly: z
        .boolean()
        .optional()
        .describe('Filter to only GPUs available in community cloud'),
      searchTerm: z
        .string()
        .optional()
        .describe(
          "Search term to filter GPUs by name (e.g., 'A100', 'RTX 4090')"
        ),
      includeUnavailable: z
        .boolean()
        .optional()
        .describe(
          'Out-of-stock GPUs are included by default (annotated availability:NONE and sorted last). Set false to hide them and list only currently-deployable GPUs.'
        ),
      includeAvailability: z
        .boolean()
        .optional()
        .describe(
          'Request realtime stock and annotate each GPU with an availability summary (HIGH/MEDIUM/LOW/NONE). Default true. Set false to skip the availability lookup — then out-of-stock GPUs cannot be filtered.'
        ),
    },
    { title: 'List GPU types', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('gpus');
      if (backend.version === 'v2') {
        // v2 REST: GET /v2/catalog/gpus?include=AVAILABILITY → { gpus: [...] },
        // each with an `availability` summary (HIGH/MEDIUM/LOW/NONE) and a
        // per-datacenter `dataCenters` breakdown. Filters re-applied against v2
        // field names. Opt out with includeAvailability:false (then the
        // filter/sort below no-op, since there's no data).
        const wantAvailability = params.includeAvailability !== false;
        const raw = await callRestUrl(
          `${backend.base}${backend.list}${
            wantAvailability ? '?include=AVAILABILITY' : ''
          }`
        );
        let gpus = backend.unwrap(raw) as Array<Record<string, unknown>>;
        // Drop the "unknown" sentinel (matches the v1 path). It's a NONE-stock
        // placeholder that used to be masked by the default hide; now that the
        // full catalog shows by default it would otherwise leak into the list.
        gpus = gpus.filter((g) => g.id !== 'unknown');
        if (params.minMemoryGb !== undefined)
          gpus = gpus.filter(
            (g) => Number(g.memory ?? 0) >= params.minMemoryGb!
          );
        if (params.secureCloudOnly) gpus = gpus.filter((g) => g.secure);
        if (params.communityCloudOnly) gpus = gpus.filter((g) => g.community);
        if (params.searchTerm) {
          const t = params.searchTerm.toLowerCase();
          gpus = gpus.filter(
            (g) =>
              String(g.id ?? '')
                .toLowerCase()
                .includes(t) ||
              String(g.name ?? '')
                .toLowerCase()
                .includes(t)
          );
        }
        // Full catalog by default; only includeUnavailable:false filters down to
        // deployable GPUs. A GPU with no `availability` from the backend is
        // treated as available, so the opt-in never over-filters.
        if (params.includeUnavailable === false)
          gpus = gpus.filter((g) => g.availability !== 'NONE');
        // Highest stock first so the best pick is at the top.
        const rank: Record<string, number> = {
          HIGH: 3,
          MEDIUM: 2,
          LOW: 1,
          NONE: 0,
        };
        gpus.sort(
          (a, b) =>
            (rank[String(b.availability)] ?? 0) -
            (rank[String(a.availability)] ?? 0)
        );
        // Drop the bulky per-datacenter breakdown from the list; keep the
        // `availability` summary. get-gpu-type returns the full detail.
        gpus = gpus.map(({ dataCenters: _dataCenters, ...rest }) => rest);
        return capListResult(gpus, {
          limit: params.limit,
          cursor: params.cursor,
        });
      }

      interface GpuTypesResponse {
        gpuTypes: Array<{
          id: string;
          displayName: string;
          memoryInGb: number;
          secureCloud: boolean;
          communityCloud: boolean;
          lowestPrice?: { stockStatus: string | null } | null;
        }>;
      }

      const data = await graphql<GpuTypesResponse>(`
        query {
          gpuTypes {
            id
            displayName
            memoryInGb
            secureCloud
            communityCloud
            lowestPrice(input: { gpuCount: 1 }) {
              stockStatus
            }
          }
        }
      `);

      const stockPriority: Record<string, number> = {
        High: 3,
        Medium: 2,
        Low: 1,
      };

      const isAvailable = (gpu: GpuTypesResponse['gpuTypes'][number]) => {
        const status = gpu.lowestPrice?.stockStatus;
        return !!status && status !== 'Out';
      };

      let gpuTypes = data.gpuTypes.filter((gpu) => gpu.id !== 'unknown');

      // Full catalog by default; opt in (includeUnavailable:false) to hide out-of-stock.
      if (params.includeUnavailable === false) {
        gpuTypes = gpuTypes.filter(isAvailable);
      }
      if (params.minMemoryGb) {
        gpuTypes = gpuTypes.filter(
          (gpu) => gpu.memoryInGb >= params.minMemoryGb!
        );
      }
      if (params.secureCloudOnly) {
        gpuTypes = gpuTypes.filter((gpu) => gpu.secureCloud);
      }
      if (params.communityCloudOnly) {
        gpuTypes = gpuTypes.filter((gpu) => gpu.communityCloud);
      }
      if (params.searchTerm) {
        const term = params.searchTerm.toLowerCase();
        gpuTypes = gpuTypes.filter(
          (gpu) =>
            gpu.id.toLowerCase().includes(term) ||
            gpu.displayName.toLowerCase().includes(term)
        );
      }

      gpuTypes.sort((a, b) => {
        const aP = stockPriority[a.lowestPrice?.stockStatus || ''] || 0;
        const bP = stockPriority[b.lowestPrice?.stockStatus || ''] || 0;
        if (bP !== aP) return bP - aP;
        return b.memoryInGb - a.memoryInGb;
      });

      const result = gpuTypes.map((gpu) => ({
        id: gpu.id,
        displayName: gpu.displayName,
        memoryGb: gpu.memoryInGb,
        secureCloud: gpu.secureCloud,
        communityCloud: gpu.communityCloud,
        stockStatus: gpu.lowestPrice?.stockStatus || 'unavailable',
        available: isAvailable(gpu),
      }));

      return capListResult(result, {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // List Data Centers
  server.tool(
    'list-data-centers',
    'List Runpod data centers (id, name, region/location). Use this to discover valid dataCenterIds for placing pods, endpoints, or network volumes.',
    {
      ...listPaginationParams,
      region: z
        .string()
        .optional()
        .describe(
          "Filter by region/location (e.g., 'United States', 'Europe', 'Canada')"
        ),
    },
    { title: 'List data centers', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('dataCenters');
      if (backend.version === 'v2') {
        // v2 REST: GET /v2/catalog/datacenters → { dataCenters: [...] }. v2 uses
        // a `region` enum (vs v1 free-text `location`); region filter matches it.
        const raw = await callRestUrl(`${backend.base}${backend.list}`);
        let dcs = backend.unwrap(raw) as Array<Record<string, unknown>>;
        if (params.region) {
          const t = params.region.toLowerCase();
          dcs = dcs.filter((dc) =>
            String(dc.region ?? '')
              .toLowerCase()
              .includes(t)
          );
        }
        return capListResult(dcs, {
          limit: params.limit,
          cursor: params.cursor,
        });
      }

      interface DataCentersResponse {
        dataCenters: Array<{
          id: string;
          name: string;
          location: string;
        }>;
      }

      const data = await graphql<DataCentersResponse>(`
        query {
          dataCenters {
            id
            name
            location
          }
        }
      `);

      let dataCenters = data.dataCenters;

      if (params.region) {
        const term = params.region.toLowerCase();
        dataCenters = dataCenters.filter((dc) =>
          dc.location.toLowerCase().includes(term)
        );
      }

      return capListResult(dataCenters, {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // List CPU Types (v2-only — v2 catalog REST has no v1/GraphQL equivalent)
  server.tool(
    'list-cpu-types',
    'List available CPU flavor types for CPU pods/endpoints. v2-only — returns a 501 notice on the v1 API.',
    { ...listPaginationParams },
    { title: 'List CPU types', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('cpus');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'list-cpu-types is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.',
          status: 501,
        });
      }
      const raw = await callRestUrl(`${backend.base}${backend.list}`);
      return capListResult(backend.unwrap(raw), {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get GPU Type by id (v2-only — GET /v2/catalog/gpus/{id})
  server.tool(
    'get-gpu-type',
    'Get details for a single GPU type by id, including per-datacenter availability. v2-only — returns a 501 notice on the v1 API (use list-gpu-types there). Use the returned dataCenters[].availability to pick a dataCenterIds with stock before creating a pod.',
    {
      gpuTypeId: z.string().describe('ID of the GPU type to retrieve'),
      includeAvailability: z
        .boolean()
        .optional()
        .describe(
          'Include realtime per-datacenter availability (HIGH/MEDIUM/LOW/NONE). Default true.'
        ),
    },
    { title: 'Get GPU type', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('gpus');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'get-gpu-type is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2 (or use list-gpu-types on v1).',
          status: 501,
        });
      }
      // GPU ids contain spaces (e.g. "NVIDIA GeForce RTX 4090"), so encode the
      // path segment. Availability on by default — it's the point of a single GPU.
      const path = backend.get!(encodeURIComponent(params.gpuTypeId));
      const query =
        params.includeAvailability === false ? '' : '?include=AVAILABILITY';
      const result = await callRestUrl(`${backend.base}${path}${query}`);
      return jsonReply(result);
    }
  );

  // Get CPU Type by id (v2-only — GET /v2/catalog/cpus/{id})
  server.tool(
    'get-cpu-type',
    'Get details for a single CPU flavor type by id. v2-only — returns a 501 notice on the v1 API (use list-cpu-types there).',
    {
      cpuTypeId: z.string().describe('ID of the CPU type to retrieve'),
    },
    { title: 'Get CPU type', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('cpus');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'get-cpu-type is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.',
          status: 501,
        });
      }
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.cpuTypeId)}`
      );
      return jsonReply(result);
    }
  );

  // Get capacity (GPU × host-CUDA availability). Public GraphQL on both API
  // versions — the v2 REST catalog's only CUDA dimension is a minCudaVersion
  // floor filter on availability (see MinCudaVersionFilter in the vendored
  // spec); the exact per-version breakdown, per-version graded stock, and
  // per-version pricing this tool returns are GraphQL-only, so unlike the
  // other catalog tools this one never branches on backendFor.
  server.tool(
    'get-capacity',
    "GPU capacity across host CUDA versions, as a matrix. Use this to choose an endpoint's allowedCudaVersions/minCudaVersion (or diagnose/widen a capacity-starved one) and to distinguish capacity problems from compatibility problems. Default mode is one call returning, per GPU type, overall stock plus AVAILABLE/UNAVAILABLE per host-reported CUDA version. Pass cudaVersions to deep-probe instead: one stock lookup per listed version, returning graded stock (High/Medium/Low/Out) and the lowest on-demand price per version; a probe that fails transiently reports a per-version error instead of failing the call. Nothing is hidden by default — set includeUnavailable:false to drop GPUs with no stock on any listed version. Credential-free public catalog data; works on both v1 and v2 APIs. Stock is live, so page cursors can shift between calls. Note: the matrix reflects host-reported versions, but endpoint allowedCudaVersions only accepts values from the platform enum — check create-endpoint/update-endpoint for the accepted list.",
    {
      ...listPaginationParams,
      cudaVersions: z
        .array(z.string().regex(/^\d{1,2}\.\d{1,2}$/))
        .min(1)
        .max(12)
        .optional()
        .describe(
          'Deep-probe these host CUDA versions (e.g. ["12.8", "13.0"], max 12): one stock lookup per version returns graded stock and price. Omit for the single-call AVAILABLE/UNAVAILABLE matrix across all versions the fleet currently reports.'
        ),
      includeUnavailable: z
        .boolean()
        .optional()
        .describe(
          'Out-of-stock GPUs are included by default (explicit "Out" cells / all-UNAVAILABLE rows, sorted last). Set false to hide GPUs with no stock on any listed version.'
        ),
      gpuTypeIds: z
        .array(z.string())
        .optional()
        .describe(
          "Filter to GPU types matching any of these ids or display names (case-insensitive substring, e.g. ['NVIDIA GeForce RTX 4090'] or ['4090', 'H200'])."
        ),
      gpuCount: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe('GPUs per worker/pod to check stock for (default 1).'),
      secureCloudOnly: z
        .boolean()
        .optional()
        .describe('Restrict the stock lookup to Secure Cloud hosts.'),
    },
    { title: 'Get GPU capacity by CUDA version', ...READ_ONLY },
    async (params) => {
      // The public GraphQL path takes no variables, so arguments are inlined.
      // Every inlined value is re-validated here at runtime (not just in zod)
      // because direct handler calls can bypass schema validation: gpuCount is
      // coerced to an int in [1,8], cudaVersions is regex-checked below, and
      // secureCloud is a literal.
      const gpuCount = Math.min(
        8,
        Math.max(1, Math.floor(Number(params.gpuCount)) || 1)
      );
      const secureArg = params.secureCloudOnly ? ', secureCloud: true' : '';

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

      // Blank/non-string filter entries are ignored (an all-blank list means
      // "no filter", same as omitting it) — a zod-bypassed [""] must not
      // silently match the whole catalog as if it were a real term.
      const filterTerms = (params.gpuTypeIds ?? [])
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

      const stockPriority: Record<string, number> = {
        High: 3,
        Medium: 2,
        Low: 1,
      };

      // Matrix mode: one query, per-version availability from the fleet.
      if (!params.cudaVersions?.length) {
        const data = await graphql<CapacityResponse>(`
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
        let rows = data.gpuTypes
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
        if (params.includeUnavailable === false)
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
        return capListResult(rows, {
          limit: params.limit,
          cursor: params.cursor,
        });
      }

      // Probe mode: one stock lookup per requested version, merged per GPU.
      // Zod caps at 12, but the cap is re-enforced here because direct handler
      // calls (tests, other transports) can bypass schema validation.
      const versions = [...new Set(params.cudaVersions)].slice(0, 12);
      const invalid = versions.filter((v) => !/^\d{1,2}\.\d{1,2}$/.test(v));
      if (invalid.length > 0) {
        return jsonReply({
          error: `Invalid CUDA version format: ${invalid.join(', ')}. Use "major.minor" strings like "12.8".`,
          status: 400,
        });
      }
      // allSettled, not all: a transient failure (429/5xx) on one probe must
      // not discard the other versions' results — the same best-effort stance
      // as get-job-status's worker fan-out. Failed versions are reported in a
      // probeErrors sibling field instead of failing the call.
      const perVersion = await Promise.allSettled(
        versions.map((v) =>
          graphql<CapacityResponse>(`
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
      const byId = new Map<
        string,
        {
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
      >();
      versions.forEach((v, i) => {
        const settled = perVersion[i];
        if (settled.status === 'rejected') {
          probeErrors[v] =
            settled.reason instanceof Error
              ? settled.reason.message
              : String(settled.reason);
          return;
        }
        for (const gpu of settled.value.gpuTypes) {
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
          // No stockStatus means no hosts match this version at all — an
          // explicit "Out" cell, so starvation is visible rather than an
          // absence the agent has to infer (a capacity-diagnosis tool must
          // not hide the empty cells it exists to reveal).
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
      const inStockCount = (r: (typeof rows)[number]) =>
        Object.values(r.cudaVersions).filter((c) => c.stock !== 'Out').length;
      if (params.includeUnavailable === false)
        rows = rows.filter((r) => inStockCount(r) > 0);
      rows.sort((a, b) => {
        const diff = inStockCount(b) - inStockCount(a);
        if (diff !== 0) return diff;
        const best = (r: (typeof rows)[number]) =>
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
      return capListResult(
        rows,
        { limit: params.limit, cursor: params.cursor },
        {
          probedCudaVersions: versions,
          ...(Object.keys(probeErrors).length > 0 ? { probeErrors } : {}),
        }
      );
    }
  );

  // Get Data Center by id (v2-only — GET /v2/catalog/datacenters/{id})
  server.tool(
    'get-data-center',
    'Get details for a single data center by id. v2-only — returns a 501 notice on the v1 API (use list-data-centers there).',
    {
      dataCenterId: z.string().describe('ID of the data center to retrieve'),
    },
    { title: 'Get data center', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('dataCenters');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'get-data-center is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.',
          status: 501,
        });
      }
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.dataCenterId)}`
      );
      return jsonReply(result);
    }
  );
}
