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
      // Every way of asking for something this tool cannot express is refused up front.
      // Each of these was, at some point, silently accepted — the request vanished, the
      // stored value was echoed back, and the reply looked like it had been applied.
      // That is issue #63's own failure mode occurring inside the tool that exists to
      // fix it, so the guards are exhaustive rather than case-by-case.

      // gpuIds is built as `pools + '-'-prefixed exclusions`, so exclusions with no
      // pools have nowhere to go.
      if (
        params.excludeGpuTypeIds?.length &&
        !params.pools?.length &&
        !params.gpuIds
      ) {
        return jsonReply({
          error:
            'excludeGpuTypeIds only applies alongside pools: gpuIds is built as the pool list plus the exclusions, so exclusions alone cannot be expressed. Pass pools together with excludeGpuTypeIds (see list-gpu-types), or pass a complete gpuIds string. To keep the current pools and add an exclusion, read the endpoint first with get-endpoint includeGpuIds:true and send the full string.',
        });
      }

      // A raw gpuIds takes precedence, so exclusions passed with it would be dropped.
      // Appending them is not safe either — gpuIds may already carry exclusions, and
      // merging two sources silently is how this class of bug started.
      if (params.excludeGpuTypeIds?.length && params.gpuIds) {
        return jsonReply({
          error:
            'gpuIds and excludeGpuTypeIds cannot be combined: a raw gpuIds string is used as-is, so the exclusions would be silently dropped. Put the exclusions in the gpuIds string yourself (comma-separated, each prefixed with "-"), or pass pools + excludeGpuTypeIds instead.',
        });
      }

      // An explicit empty pool list is a request, not an omission — and an unfulfillable
      // one. update-endpoint rejects the identical input on v2; this used to ignore it.
      if (params.pools !== undefined && params.pools.length === 0) {
        return jsonReply({
          error:
            'pools cannot be empty: an endpoint must allow at least one GPU pool. Pass the pools you want (see list-gpu-types), or omit pools to keep the current selection.',
        });
      }

      // '' survives `??`, so it used to reach the "no GPU selection to keep" branch and
      // be reported as a CPU endpoint.
      if (params.gpuIds !== undefined && params.gpuIds.trim() === '') {
        return jsonReply({
          error:
            'gpuIds cannot be empty. Pass a pool list (e.g. "AMPERE_16", optionally with "-"-prefixed exclusions), or omit gpuIds to keep the current selection.',
        });
      }

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
        // Phrased without asserting a diagnosis: this catch also sees a 401 on an
        // expired key, a GraphQL 500 and a DNS failure, and telling someone their
        // endpoint id is wrong when their credential expired sends them the wrong way.
        // An unknown or foreign id is the common case, so it is named as a likely
        // cause rather than the cause.
        return jsonReply({
          error: `Could not read endpoint "${params.endpointId}" over GraphQL, so nothing was changed. If the id is right, the credential or the API may be at fault; if it may be wrong, list-endpoints shows the endpoints this credential can see. Cause: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (!current) {
        return jsonReply({
          error: `Could not read endpoint "${params.endpointId}": the GraphQL API returned no user for this credential.`,
        });
      }

      // A CPU endpoint cannot hold a GPU selection, and the server does not say so — it
      // silently discards it. `validateAndNormalizeInstanceIds` derives computeType=CPU
      // from a `cpu*` instanceId, `validateAndNormalizeGpuConfig` returns undefined for
      // anything not GPU without even looking at the gpuIds, and the update then writes
      // `gpuIds: normalizedGpuIds || null` — i.e. null. Verified in runpod-backend
      // (aiApiHelpers.ts validateAndNormalizeGpuConfig, aiApi.ts:2711). So a write DID
      // happen, re-validating the config and eligible to roll the workers, while the
      // requested pin was never stored and the reply claimed success.
      if (requestedGpuIds !== undefined && current.instanceIds.length > 0) {
        return jsonReply({
          error: `Endpoint "${params.endpointId}" is a CPU endpoint (instances: ${current.instanceIds.join(', ')}), and a GPU selection cannot be applied to one — the server would discard it silently. Nothing was changed. Use update-endpoint to change a CPU endpoint's instance types.`,
        });
      }

      // Falls back to the stored value, so a count-only or CUDA-only change preserves
      // the endpoint's GPU selection — SKU exclusions and all.
      const gpuIds = requestedGpuIds ?? current.gpuIds;
      if (!gpuIds) {
        return jsonReply({
          error: `Endpoint "${params.endpointId}" has no stored GPU selection to keep, so gpuIds or pools must be provided.`,
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
