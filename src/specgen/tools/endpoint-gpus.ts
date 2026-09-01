// Curated set-endpoint-gpus tool. Pinning specific GPU SKUs needs the GraphQL
// `gpuIds` string ("POOL[,POOL...][,-<GPU type id>...]") — REST's gpu field is
// {pools, count} with no SKU exclusion, so this capability has no REST home.
// Ported from the official MCP server (Apache-2.0, runpod/runpod-mcp).
//
// The GraphQL saveEndpoint mutation is NOT a sparse update — unlike the REST
// PATCH, an id+name+gpuIds-only call resets workersMax, idleTimeout, and
// scalerValue to server defaults — so this tool reads the endpoint and echoes
// every field back with only gpuIds (and gpuCount/CUDA fields) changed. Read
// shapes are
// not write shapes: networkVolumeIds reads {networkVolumeId, dataCenterId}
// but NetworkVolumeIdsInput accepts networkVolumeId ONLY.

import type { CuratedTool } from '../server.js';
import { badRequest, ok, runTool } from './util.js';

interface EndpointSnapshot {
  id: string;
  name: string;
  gpuIds: string;
  gpuCount: number;
  workersMin: number;
  workersMax: number;
  idleTimeout: number;
  scalerType: string;
  scalerValue: number;
  executionTimeoutMs: number;
  flashBootType: string;
  type: string;
  locations: string | null;
  templateId: string | null;
  // A comma-separated String on read AND write, not a list.
  allowedCudaVersions: string | null;
  minCudaVersion: string | null;
  // A [Compliance] enum on input — read values are already enum names, pass
  // back verbatim.
  compliance: string[] | null;
  modelReferences: string[] | null;
  networkVolumeIds: Array<{
    networkVolumeId: string;
    dataCenterId: string | null;
  }> | null;
}

interface MyEndpointsResponse {
  myself: { endpoints: EndpointSnapshot[] };
}

interface SaveEndpointResponse {
  saveEndpoint: {
    id: string;
    name: string;
    gpuIds: string;
    gpuCount: number;
    workersMin: number;
    workersMax: number;
  };
}

export const setEndpointGpus: CuratedTool = {
  name: 'set-endpoint-gpus',
  description:
    "Set which GPUs a Serverless endpoint's workers run on — including pinning specific GPU SKUs, which create-endpoint/update-endpoint cannot express. Provide either a raw gpuIds string, or pools plus optional excludeGpuTypeIds (GPU type ids from list-gpu-types) and the exclusion string is built for you: a pool allows every SKU in it, and excluding all but one SKU pins that SKU exactly. All other endpoint settings (workers, scaling, timeouts, template) are read first and preserved. Uses the authenticated GraphQL API.",
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        type: 'string',
        description: 'ID of the Serverless endpoint to update',
      },
      gpuIds: {
        type: 'string',
        description:
          "Raw gpuIds string, e.g. 'ADA_24' or 'AMPERE_16,-NVIDIA RTX A4500'. Takes precedence over pools/excludeGpuTypeIds.",
      },
      pools: {
        type: 'array',
        items: { type: 'string' },
        description:
          "GPU pool names workers may use (e.g. ['ADA_80_PRO','AMPERE_80']). The pool field from list-gpu-types.",
      },
      excludeGpuTypeIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          "GPU type ids to exclude from the allowed pools (e.g. ['NVIDIA H100 NVL']). Use with pools to pin specific SKUs.",
      },
      gpuCount: {
        type: 'integer',
        minimum: 1,
        description: 'GPUs per worker. Omit to keep the current value.',
      },
      minCudaVersion: {
        type: 'string',
        description:
          "Minimum host CUDA version workers may run on (e.g. '12.4'). Omit to keep the current value.",
      },
      allowedCudaVersions: {
        type: 'string',
        description:
          "Comma-separated allowed host CUDA versions (e.g. '12.8,12.7,12.6'). Omit to keep the current value. CUDA compatibility is part of GPU selection — a narrow list can leave an endpoint unable to schedule workers.",
      },
    },
    required: ['endpointId'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const pools = args.pools as string[] | undefined;
      const gpuIds =
        (args.gpuIds as string | undefined) ??
        (pools && pools.length > 0
          ? [
              ...pools,
              ...((args.excludeGpuTypeIds as string[] | undefined) ?? []).map(
                (id) => `-${id}`
              ),
            ].join(',')
          : undefined);
      if (!gpuIds) {
        return badRequest(
          'Provide gpuIds (raw string) or pools (with optional excludeGpuTypeIds). See list-gpu-types for pool names and GPU type ids.'
        );
      }

      // Read the endpoint's current settings — saveEndpoint resets omitted
      // endpoint-level fields to defaults, so everything must be echoed back.
      const data = await ctx.graphql.authed<MyEndpointsResponse>(`
        query {
          myself {
            endpoints {
              id
              name
              gpuIds
              gpuCount
              workersMin
              workersMax
              idleTimeout
              scalerType
              scalerValue
              executionTimeoutMs
              flashBootType
              type
              locations
              templateId
              allowedCudaVersions
              minCudaVersion
              compliance
              modelReferences
              networkVolumeIds {
                networkVolumeId
                dataCenterId
              }
            }
          }
        }
      `);
      const current = data.myself.endpoints.find(
        (e) => e.id === args.endpointId
      );
      if (!current) {
        return badRequest(
          `No Serverless endpoint found with id "${args.endpointId}". Use list-endpoints to see your endpoints.`
        );
      }

      const input: Record<string, unknown> = {
        id: current.id,
        name: current.name,
        gpuIds,
        gpuCount: (args.gpuCount as number | undefined) ?? current.gpuCount,
        workersMin: current.workersMin,
        workersMax: current.workersMax,
        idleTimeout: current.idleTimeout,
        scalerType: current.scalerType,
        scalerValue: current.scalerValue,
        executionTimeoutMs: current.executionTimeoutMs,
        flashBootType: current.flashBootType,
        type: current.type,
        locations: current.locations,
        networkVolumeIds:
          current.networkVolumeIds && current.networkVolumeIds.length > 0
            ? // Drop dataCenterId: NetworkVolumeIdsInput takes networkVolumeId
              // ONLY; the read shape is rejected outright.
              current.networkVolumeIds.map((v) => ({
                networkVolumeId: v.networkVolumeId,
              }))
            : null,
      };

      // Echoed only when set. Omitting a field that currently reads null
      // resets it to a default that is already null, while an explicit null
      // risks a server-side type rejection for no gain.
      for (const [key, value] of Object.entries({
        templateId: current.templateId,
        allowedCudaVersions:
          (args.allowedCudaVersions as string | undefined) ??
          current.allowedCudaVersions,
        minCudaVersion:
          (args.minCudaVersion as string | undefined) ?? current.minCudaVersion,
        compliance: current.compliance,
        modelReferences: current.modelReferences,
      })) {
        if (value !== null && value !== undefined) input[key] = value;
      }

      const result = await ctx.graphql.authed<SaveEndpointResponse>(
        `
          mutation saveEndpoint($input: EndpointInput!) {
            saveEndpoint(input: $input) {
              id
              name
              gpuIds
              gpuCount
              workersMin
              workersMax
            }
          }
        `,
        { input }
      );

      return ok({
        endpoint: result.saveEndpoint,
        previousGpuIds: current.gpuIds,
      });
    }),
};
