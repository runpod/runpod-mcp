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
    'List available GPU types with stock/pricing and capability filters (minimum VRAM, secure/community cloud, name search). Use this to discover valid gpuTypeIds before creating a pod or endpoint. On v2 the realtime stock filter is a no-op.',
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
          'Include GPUs that are currently out of stock. Default is false'
        ),
    },
    { title: 'List GPU types', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('gpus');
      if (backend.version === 'v2') {
        // v2 REST: GET /v2/catalog/gpus → { gpus: [...] }. Filters re-applied
        // against v2 field names (memory/secure/community/name). v2 has no
        // realtime stockStatus, so `includeUnavailable` is a documented no-op.
        const raw = await callRestUrl(`${backend.base}${backend.list}`);
        let gpus = backend.unwrap(raw) as Array<Record<string, unknown>>;
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

      if (!params.includeUnavailable) {
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
    'Get details for a single GPU type by id. v2-only — returns a 501 notice on the v1 API (use list-gpu-types there).',
    {
      gpuTypeId: z.string().describe('ID of the GPU type to retrieve'),
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
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.gpuTypeId)}`
      );
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
