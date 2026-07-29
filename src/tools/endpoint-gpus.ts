import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WRITE, type ToolRuntime } from './runtime.js';
import {
  readEndpointSnapshot,
  buildSaveEndpointInput,
  saveEndpoint,
} from '../_shared/endpoint-gpu-ids.js';

// ============== ENDPOINT GPU PINNING ==============
// Sets which GPUs a Serverless endpoint's workers run on, including pinning
// specific GPU SKUs — a capability the REST API cannot express (its
// gpuPoolIds field has no SKU exclusion concept). The GraphQL `gpuIds` string
// is "POOL[,POOL...][,-<GPU type id>...]": pool names allow every SKU in the
// pool, and '-'-prefixed GPU type ids (from list-gpu-types) exclude SKUs, so
// a pool minus all-but-one SKU pins that SKU exactly.
//
// saveEndpoint is NOT a sparse update. Measured live with an
// id+name+gpuIds-only update: workersMax 7→3, idleTimeout 42→10, scalerValue
// 9→4 all reset to server defaults. Everything else held — including templateId,
// the CUDA fields, compliance and modelReferences. So the reset set is narrower
// than "every omitted field", but it is undocumented server behavior and could
// widen, so this tool reads the endpoint and echoes every field back with only
// gpuIds (and gpuCount) changed.
//
// Read shapes are not write shapes: networkVolumeIds reads as `NetworkVolumeIds`
// (networkVolumeId + dataCenterId) but writes as `NetworkVolumeIdsInput`
// (networkVolumeId ONLY), so echoing it verbatim gives `Field "dataCenterId" is
// not defined by type "NetworkVolumeIdsInput"` and breaks every volume-bearing
// endpoint.

export function registerEndpointGpuTools(
  server: McpServer,
  rt: ToolRuntime
): void {
  const { graphqlAuthed, jsonReply } = rt;

  server.tool(
    'set-endpoint-gpus',
    "Set which GPUs a Serverless endpoint's workers run on — including pinning specific GPU SKUs, which create-endpoint/update-endpoint cannot express. Provide either a raw gpuIds string, or pools plus optional excludeGpuTypeIds (GPU type ids from list-gpu-types) and the exclusion string is built for you: a pool allows every SKU in it, and excluding all but one SKU pins that SKU exactly (e.g. pools:['AMPERE_16'], excludeGpuTypeIds:['NVIDIA RTX 2000 Ada Generation','NVIDIA RTX 4000 Ada Generation','NVIDIA RTX A4500'] pins RTX A4000). All other endpoint settings (workers, scaling, timeouts, template) are read first and preserved. Works on any Serverless endpoint via the authenticated GraphQL API.",
    {
      endpointId: z
        .string()
        .describe('ID of the Serverless endpoint to update'),
      gpuIds: z
        .string()
        .optional()
        .describe(
          "Raw gpuIds string, e.g. 'ADA_24' or 'AMPERE_16,-NVIDIA RTX A4500'. Takes precedence over pools/excludeGpuTypeIds."
        ),
      pools: z
        .array(z.string())
        .optional()
        .describe(
          "GPU pool names workers may use (e.g. ['ADA_80_PRO','AMPERE_80']). The pool field from list-gpu-types."
        ),
      excludeGpuTypeIds: z
        .array(z.string())
        .optional()
        .describe(
          "GPU type ids to exclude from the allowed pools (e.g. ['NVIDIA H100 NVL']). Use with pools to pin specific SKUs."
        ),
      gpuCount: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('GPUs per worker. Omit to keep the current value.'),
      minCudaVersion: z
        .string()
        .optional()
        .describe(
          "Minimum host CUDA version workers may run on (e.g. '12.4'). Omit to keep the current value."
        ),
      allowedCudaVersions: z
        .string()
        .optional()
        .describe(
          "Comma-separated allowed host CUDA versions (e.g. '12.8,12.7,12.6'). Omit to keep the current value. CUDA compatibility is part of GPU selection — a narrow list can leave an endpoint unable to schedule workers."
        ),
    },
    { title: 'Set endpoint GPUs', ...WRITE, idempotentHint: true },
    async (params) => {
      const gpuIds =
        params.gpuIds ??
        (params.pools && params.pools.length > 0
          ? [
              ...params.pools,
              ...(params.excludeGpuTypeIds ?? []).map((id) => `-${id}`),
            ].join(',')
          : undefined);
      if (!gpuIds) {
        return jsonReply({
          error:
            'Provide gpuIds (raw string) or pools (with optional excludeGpuTypeIds). See list-gpu-types for pool names and GPU type ids.',
        });
      }

      // Read the endpoint's current settings — saveEndpoint resets omitted
      // endpoint-level fields to defaults, so everything must be echoed back.
      const current = await readEndpointSnapshot(
        graphqlAuthed,
        params.endpointId
      );
      if (!current) {
        return jsonReply({
          error: `No Serverless endpoint found with id "${params.endpointId}". Use list-endpoints to see your endpoints.`,
        });
      }

      const result = await saveEndpoint(
        graphqlAuthed,
        buildSaveEndpointInput(current, {
          gpuIds,
          gpuCount: params.gpuCount,
          allowedCudaVersions: params.allowedCudaVersions,
          minCudaVersion: params.minCudaVersion,
        })
      );

      return jsonReply({
        endpoint: result.saveEndpoint,
        previousGpuIds: current.gpuIds,
      });
    }
  );
}
