import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WRITE, jsonErrorReply, type ToolRuntime } from './runtime.js';
import {
  readEndpointSnapshot,
  buildSaveEndpointInput,
  saveEndpoint,
} from '../_shared/endpoint-gpu-ids.js';
import { v2AuthedGraphqlEnvironmentSkew } from '../_shared/backend.js';

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
  const { graphqlAuthed, jsonReply, callRestUrl, backendFor, env } = rt;

  // Which SKUs each requested pool contains, from the GPU catalog — or null when that
  // cannot be established (v1 catalog has no pool field, or the call failed).
  //
  // Needed because an exclusion token that matches no SKU is a silent no-op. The server
  // validates less than it looks like it does: validateGpuIds rejects an exclusion that
  // IS a pool id and rejects excluding everything, but membership is
  // `expandedGpus.filter(g => !exclusionTokens.includes(g))` — an exact string compare —
  // so "-NVIDIA RTX 4000 Ada" (real id ends " Generation") stores fine and excludes
  // nothing. The caller asked to pin one SKU and got the whole pool, reported as success.
  // Verified in runpod-backend node/graphql/schema/aiApiHelpers.ts:126-166.
  //
  // Best-effort by design: this is a GraphQL tool that must keep working when the REST
  // catalog is unavailable, so a failure here downgrades to a disclosure rather than
  // blocking the write.
  async function poolMembership(
    pools: string[]
  ): Promise<Map<string, string[]> | null> {
    try {
      const backend = backendFor('gpus');
      if (backend.version !== 'v2' || !backend.list) return null;
      const raw = await callRestUrl(`${backend.base}${backend.list}`);
      const gpus = backend.unwrap(raw) as Array<Record<string, unknown>>;
      if (!Array.isArray(gpus) || gpus.length === 0) return null;
      // If the catalog carries no pool data at all, this check cannot be made — as
      // opposed to a pool genuinely having no SKUs.
      if (!gpus.some((g) => typeof g.pool === 'string')) return null;
      const membership = new Map<string, string[]>();
      for (const pool of pools) {
        membership.set(
          pool,
          gpus
            .filter((g) => g.pool === pool && typeof g.id === 'string')
            .map((g) => g.id as string)
        );
      }
      return membership;
    } catch {
      return null;
    }
  }

  server.tool(
    'set-endpoint-gpus',
    "Set which GPUs a Serverless endpoint's workers run on — including pinning specific GPU SKUs, which create-endpoint/update-endpoint cannot express. Provide either a raw gpuIds string, or pools plus optional excludeGpuTypeIds (GPU type ids from list-gpu-types) and the exclusion string is built for you: a pool allows every SKU in it, and excluding all but one SKU pins that SKU exactly (e.g. pools:['AMPERE_16'], excludeGpuTypeIds:['NVIDIA RTX 2000 Ada Generation','NVIDIA RTX 4000 Ada Generation','NVIDIA RTX A4500'] pins RTX A4000). The GraphQL API requires a full read-then-save: other settings are re-applied, EXCEPT workersStandby, which always resets to workersMax. The sequence is not atomic, so do not edit the endpoint concurrently; a change made between the read and save can be overwritten. Works on any Serverless endpoint via the authenticated GraphQL API.",
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
      // Every combination below was, at some point, silently accepted — the request
      // vanished, the stored value was echoed back, and the reply looked like it had
      // been applied. That is issue #63's own failure mode occurring inside the tool
      // that exists to fix it.
      //
      // These are case-by-case, and an earlier revision of this comment claimed they
      // were "exhaustive". They were not: `pools` combined with `gpuIds` was dropped by
      // the same `??` above, one parameter over from the exclusion case that had a
      // guard. Claiming completeness here is what stopped that being looked for, so:
      // any NEW parameter feeding requestedGpuIds needs its own guard, and the claim
      // stays out.

      // gpuIds is built as `pools + '-'-prefixed exclusions`, so exclusions with no
      // pools have nowhere to go.
      if (
        params.excludeGpuTypeIds?.length &&
        !params.pools?.length &&
        !params.gpuIds
      ) {
        return jsonErrorReply({
          error:
            'excludeGpuTypeIds only applies alongside pools: gpuIds is built as the pool list plus the exclusions, so exclusions alone cannot be expressed. Pass pools together with excludeGpuTypeIds (see list-gpu-types), or pass a complete gpuIds string. To keep the current pools and add an exclusion, read the endpoint first with get-endpoint includeGpuIds:true and send the full string.',
        });
      }

      // A raw gpuIds takes precedence, so exclusions passed with it would be dropped.
      // Appending them is not safe either — gpuIds may already carry exclusions, and
      // merging two sources silently is how this class of bug started.
      if (params.excludeGpuTypeIds?.length && params.gpuIds) {
        return jsonErrorReply({
          error:
            'gpuIds and excludeGpuTypeIds cannot be combined: a raw gpuIds string is used as-is, so the exclusions would be silently dropped. Put the exclusions in the gpuIds string yourself (comma-separated, each prefixed with "-"), or pass pools + excludeGpuTypeIds instead.',
        });
      }

      // Same drop, one parameter over: `params.gpuIds ?? (pools…)` takes the left branch
      // whenever gpuIds is present, so `pools` never reaches the mutation, the server or
      // the reply. Round 7 called this a blocker for excludeGpuTypeIds and guarded it;
      // pools went unguarded for two more rounds because the comment above claimed the
      // set was complete.
      if (params.pools?.length && params.gpuIds) {
        return jsonErrorReply({
          error:
            'gpuIds and pools cannot be combined: a raw gpuIds string is used as-is, so the pool list would be silently dropped. Pass pools (with optional excludeGpuTypeIds) to have the string built for you, or pass a complete gpuIds string containing the pools you want.',
        });
      }

      // An explicit empty pool list is a request, not an omission — and an unfulfillable
      // one. update-endpoint rejects the identical input on v2; this used to ignore it.
      if (params.pools !== undefined && params.pools.length === 0) {
        return jsonErrorReply({
          error:
            'pools cannot be empty: an endpoint must allow at least one GPU pool. Pass the pools you want (see list-gpu-types), or omit pools to keep the current selection.',
        });
      }

      // '' survives `??`, so it used to reach the "no GPU selection to keep" branch and
      // be reported as a CPU endpoint.
      if (params.gpuIds !== undefined && params.gpuIds.trim() === '') {
        return jsonErrorReply({
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
        return jsonErrorReply({
          error:
            'Nothing to change. Provide gpuIds (raw string) or pools (with optional excludeGpuTypeIds), and/or gpuCount / minCudaVersion / allowedCudaVersions. See list-gpu-types for pool names and GPU type ids.',
        });
      }

      // An exclusion that matches no SKU in the requested pools is a silent no-op that
      // the server accepts, so it is checked here — before anything is written — rather
      // than letting "pin this one SKU" quietly become "use the whole pool".
      let exclusionsUnvalidated = false;
      let exclusionsValidationReason: string | undefined;
      if (params.excludeGpuTypeIds?.length && params.pools?.length) {
        const environmentSkew = v2AuthedGraphqlEnvironmentSkew(env);
        const membership = environmentSkew
          ? null
          : await poolMembership(params.pools);
        if (environmentSkew) {
          exclusionsUnvalidated = true;
          exclusionsValidationReason =
            'The v2 REST GPU catalog and authenticated GraphQL API do not form a matched environment pair, so the catalog was not consulted.';
        } else if (!membership) {
          exclusionsUnvalidated = true;
          exclusionsValidationReason = 'The GPU catalog could not be read.';
        } else {
          const available = [...membership.values()].flat();
          const unmatched = params.excludeGpuTypeIds.filter(
            (id) => !available.includes(id)
          );
          if (unmatched.length > 0) {
            return jsonErrorReply({
              error: `excludeGpuTypeIds ${unmatched.map((id) => `"${id}"`).join(', ')} ${unmatched.length === 1 ? 'does' : 'do'} not match any GPU type in ${params.pools.length === 1 ? 'pool' : 'pools'} ${params.pools.join(', ')}, so ${unmatched.length === 1 ? 'it' : 'they'} would exclude nothing and the endpoint would be left able to run on every SKU in the pool. Exclusions are matched by exact id. Nothing was changed.`,
              availableGpuTypeIds: Object.fromEntries(membership),
            });
          }
        }
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
        return jsonErrorReply({
          error: `Could not read endpoint "${params.endpointId}" over GraphQL, so nothing was changed. If the id is right, the credential or the API may be at fault; if it may be wrong, list-endpoints shows the endpoints this credential can see. Cause: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      if (!current) {
        return jsonErrorReply({
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
        return jsonErrorReply({
          error: `Endpoint "${params.endpointId}" is a CPU endpoint (instances: ${current.instanceIds.join(', ')}), and a GPU selection cannot be applied to one — the server would discard it silently. Nothing was changed. Use update-endpoint to change a CPU endpoint's instance types.`,
        });
      }

      // Falls back to the stored value, so a count-only or CUDA-only change preserves
      // the endpoint's GPU selection — SKU exclusions and all.
      const gpuIds = requestedGpuIds ?? current.gpuIds;
      if (!gpuIds) {
        return jsonErrorReply({
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
        // Disclosed, not omitted: an unmatched exclusion silently widens the selection
        // to the whole pool, so "we could not check" has to be visible in the reply.
        ...(exclusionsUnvalidated
          ? {
              _exclusionsUnvalidated: `${exclusionsValidationReason} The excludeGpuTypeIds could not be checked against the pools. An id that matches no SKU exactly is accepted by the API and excludes nothing — verify against the GPU catalog for the same environment, and re-read this endpoint with get-endpoint includeGpuIds:true.`,
            }
          : {}),
      });
    }
  );
}
