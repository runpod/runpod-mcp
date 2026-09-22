// GPU-selection convenience tool. REST v2 supports exclusions directly, so a
// sparse PATCH replaces the legacy GraphQL read/echo/write operation.
import type { components } from '@runpod/typescript-api-sdk';
import type { CuratedTool } from '../types.js';
import { restError } from '../clients/rest-result.js';
import { badRequest, ok, runTool } from './util.js';
import { idempotentWrite } from './annotations.js';

type GpuSelection = { pools: string[]; excludedTypes: string[] };
const CUDA_VERSION = /^\d+\.\d+$/;

function nonemptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function gpuSelection(args: Record<string, unknown>): GpuSelection | string {
  if (args.gpuIds !== undefined) {
    if (typeof args.gpuIds !== 'string' || !args.gpuIds.trim())
      return 'gpuIds must be a non-empty string.';
    const selection: GpuSelection = { pools: [], excludedTypes: [] };
    for (const value of args.gpuIds.split(',').map((value) => value.trim())) {
      if (!value || value === '-')
        return 'gpuIds contains an empty pool or GPU exclusion.';
      if (value.startsWith('-'))
        selection.excludedTypes.push(value.slice(1).trim());
      else selection.pools.push(value);
    }
    return selection.pools.length
      ? selection
      : 'gpuIds must include at least one GPU pool.';
  }
  if (!nonemptyStrings(args.pools) || args.pools.length === 0)
    return 'Provide gpuIds or a non-empty pools array. See list-gpu-types for pool names.';
  if (
    args.excludeGpuTypeIds !== undefined &&
    !nonemptyStrings(args.excludeGpuTypeIds)
  )
    return 'excludeGpuTypeIds must be an array of non-empty strings.';
  return {
    pools: args.pools.map((value) => value.trim()),
    excludedTypes:
      (args.excludeGpuTypeIds as string[] | undefined)?.map((value) =>
        value.trim()
      ) ?? [],
  };
}

function formatGpuIds(gpu: {
  pools?: string[];
  excludedTypes?: string[];
}): string {
  return [
    ...(gpu.pools ?? []),
    ...(gpu.excludedTypes ?? []).map((id) => `-${id}`),
  ].join(',');
}

export const setEndpointGpus: CuratedTool = {
  name: 'set-endpoint-gpus',
  annotations: idempotentWrite,
  description:
    "Set which GPUs a Serverless endpoint's workers run on — including pinning specific GPU SKUs. Provide either a raw gpuIds string, or pools plus optional excludeGpuTypeIds (GPU type ids from list-gpu-types) and the exclusion string is built for you: a pool allows every SKU in it, and excluding all but one SKU pins that SKU exactly. Updates only GPU settings through REST v2, preserving other endpoint settings. create-endpoint/update-endpoint also support gpu.excludedTypes.",
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
          "Minimum host CUDA version workers may run on (e.g. '12.4'). Omit to keep the current value; use an empty string to clear it.",
      },
      allowedCudaVersions: {
        type: 'string',
        description:
          "Comma-separated allowed host CUDA versions (e.g. '12.8,12.7,12.6'). Omit to keep the current value; use an empty string to clear the list. CUDA compatibility is part of GPU selection — a narrow list can leave an endpoint unable to schedule workers.",
      },
    },
    required: ['endpointId'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const selection = gpuSelection(args);
      if (typeof selection === 'string') return badRequest(selection);
      if (typeof args.endpointId !== 'string' || !args.endpointId.trim())
        return badRequest('endpointId must be a non-empty string.');
      if (
        args.gpuCount !== undefined &&
        (!Number.isSafeInteger(args.gpuCount) || Number(args.gpuCount) < 1)
      )
        return badRequest('gpuCount must be a positive integer.');
      if (
        args.minCudaVersion !== undefined &&
        (typeof args.minCudaVersion !== 'string' ||
          (args.minCudaVersion !== '' &&
            !CUDA_VERSION.test(args.minCudaVersion)))
      )
        return badRequest(
          'minCudaVersion must be major.minor, or an empty string to clear it.'
        );
      if (
        args.allowedCudaVersions !== undefined &&
        typeof args.allowedCudaVersions !== 'string'
      )
        return badRequest(
          'allowedCudaVersions must be a comma-separated string.'
        );
      const allowed =
        typeof args.allowedCudaVersions === 'string'
          ? args.allowedCudaVersions
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean)
          : undefined;
      if (allowed?.some((value) => !CUDA_VERSION.test(value)))
        return badRequest(
          'allowedCudaVersions must contain major.minor versions.'
        );
      if (allowed?.length && args.minCudaVersion)
        return badRequest(
          'Set either allowedCudaVersions or minCudaVersion, not both.'
        );

      const params = { path: { id: args.endpointId } };
      const current = await ctx.sdk.GET('/v2/serverless/{id}', { params });
      if (!current.response.ok)
        return restError(current.response, current.error);
      if (!current.data?.gpu)
        return badRequest('This endpoint does not have a GPU configuration.');
      const gpu: components['schemas']['UpdateEndpointGpuConfig'] = {
        ...selection,
        ...(args.gpuCount !== undefined
          ? { count: args.gpuCount as number }
          : {}),
        ...(args.minCudaVersion !== undefined
          ? { minCudaVersion: args.minCudaVersion as string }
          : {}),
        ...(allowed !== undefined ? { allowedCudaVersions: allowed } : {}),
      };
      const updated = await ctx.sdk.PATCH('/v2/serverless/{id}', {
        params,
        body: { gpu },
      });
      if (!updated.response.ok)
        return restError(updated.response, updated.error);
      const updatedGpu = updated.data?.gpu;
      if (!updated.data || !updatedGpu)
        return {
          ok: false,
          status: 502,
          payload: { error: 'The API returned no updated GPU endpoint.' },
        };
      const endpoint = updated.data;
      return ok({
        endpoint: {
          id: endpoint.id,
          name: endpoint.name,
          gpuIds: formatGpuIds(updatedGpu),
          gpuCount: updatedGpu.count,
          workersMin: endpoint.workers?.min,
          workersMax: endpoint.workers?.max,
        },
        previousGpuIds: formatGpuIds(current.data.gpu),
      });
    }),
};
