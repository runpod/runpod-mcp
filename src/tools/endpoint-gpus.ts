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
// saveEndpoint is NOT a sparse update: measured live with an id+name+gpuIds-only
// update, workersMax 7→3, idleTimeout 42→10 and scalerValue 9→4 all reset to server
// defaults. Which fields must be echoed, and which must NOT be, is worked out once in
// src/_shared/endpoint-gpu-ids.ts — see buildSaveEndpointInput for the field-by-field
// reasoning. Do not restate it here; two copies of this analysis is how it goes
// stale.

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
      const requestedGpuIds =
        params.gpuIds ??
        (params.pools && params.pools.length > 0
          ? [
              ...params.pools,
              ...(params.excludeGpuTypeIds ?? []).map((id) => `-${id}`),
            ].join(',')
          : undefined);
      // A GPU selection is required only when there is nothing else to change. A
      // count-only call is legitimate and is what update-endpoint sends people here
      // for — it keeps the stored gpuIds (exclusions included), which is the whole
      // reason that advice exists. Rejecting it made the advice a dead end.
      const changesSomething =
        requestedGpuIds !== undefined ||
        params.gpuCount !== undefined ||
        params.minCudaVersion !== undefined ||
        params.allowedCudaVersions !== undefined;
      if (!changesSomething) {
        return jsonReply({
          error:
            'Nothing to change. Provide gpuIds (raw string) or pools (with optional excludeGpuTypeIds), and/or gpuCount / minCudaVersion / allowedCudaVersions. See list-gpu-types for pool names and GPU type ids.',
        });
      }

      // Read the endpoint's current settings — saveEndpoint resets omitted
      // endpoint-level fields to defaults, so everything must be echoed back.
      // Two distinct not-found shapes, and both need to stay actionable. The
      // resolver THROWS for an id it cannot see (findFirstOrThrow), so an unknown or
      // foreign id arrives as a rejection, not as a null — catching it is what keeps
      // the "use list-endpoints" pointer that a raw GraphQL error would lose. A null
      // means something else entirely: the API returned no user for this credential.
      let current;
      try {
        current = await readEndpointSnapshot(graphqlAuthed, params.endpointId);
      } catch (error) {
        return jsonReply({
          error: `No Serverless endpoint readable with id "${params.endpointId}". Use list-endpoints to see your endpoints. Cause: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (!current) {
        return jsonReply({
          error: `Could not read endpoint "${params.endpointId}": the GraphQL API returned no user for this credential.`,
        });
      }

      // Falls back to the stored value, so a count-only or CUDA-only change preserves
      // the endpoint's GPU selection — SKU exclusions and all.
      const gpuIds = requestedGpuIds ?? current.gpuIds;
      if (!gpuIds) {
        return jsonReply({
          error: `Endpoint "${params.endpointId}" has no GPU selection to keep (a CPU endpoint has no gpuIds), so gpuIds or pools must be provided.`,
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
