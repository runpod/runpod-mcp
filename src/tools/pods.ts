import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { capListResult, listPaginationParams } from '../pagination.js';
import { HttpError } from '../_shared/http.js';
import { restV1Base } from '../_shared/backend.js';
import { READ_ONLY, WRITE, DESTRUCTIVE, type ToolRuntime } from './runtime.js';

// ============== POD MANAGEMENT TOOLS ==============

// One parsed Server-Sent-Events log frame from GET /v2/pods/{id}/logs. The API
// emits `data: {"source","line","ts"}` events; a frame that doesn't parse as
// JSON is preserved verbatim under `raw` rather than dropped.
export interface PodLogEntry {
  source?: string;
  line?: string;
  ts?: string;
  raw?: string;
}

// Parse the raw accumulated event-stream text into log entries. Pure (no I/O),
// so the risky parsing logic is unit-tested without a network. SSE events are
// separated by a blank line; the payload is the `data:` field (possibly spanning
// multiple `data:` lines per the SSE spec). Non-JSON payloads fall back to
// `{raw}`. Comment lines (`:`...) and other fields (event:/id:) are ignored.
export function parsePodLogSse(raw: string): PodLogEntry[] {
  const items: PodLogEntry[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'));
    if (!dataLines.length) continue;
    // Strip the `data:` field name and one optional leading space per line.
    const payload = dataLines
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!payload.trim()) continue;
    try {
      items.push(JSON.parse(payload) as PodLogEntry);
    } catch {
      items.push({ raw: payload });
    }
  }
  return items;
}

export function registerPodTools(server: McpServer, rt: ToolRuntime): void {
  const { jsonReply, callRestUrl, backendFor, streamSse, podAction, env } = rt;

  // List Pods
  server.tool(
    'list-pods',
    'List your pods (running and stopped) with optional filters — compute type, GPU type, data center, name — plus machine/network-volume expansion. Paginated via limit/cursor.',
    {
      ...listPaginationParams,
      computeType: z
        .enum(['GPU', 'CPU'])
        .optional()
        .describe('Filter to only GPU or only CPU Pods'),
      gpuTypeId: z
        .array(z.string())
        .optional()
        .describe('Filter to Pods with any of the listed GPU types'),
      dataCenterId: z
        .array(z.string())
        .optional()
        .describe('Filter to Pods in any of the provided data centers'),
      name: z
        .string()
        .optional()
        .describe('Filter to Pods with the provided name'),
      includeMachine: z
        .boolean()
        .optional()
        .describe('Include information about the machine'),
      includeNetworkVolume: z
        .boolean()
        .optional()
        .describe('Include information about attached network volumes'),
    },
    { title: 'List pods', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('pods');

      // v1 supports query-param filters; v2 has none (the spec declares no query
      // params and ignores them), so we only build the query string under v1.
      let queryString = '';
      if (backend.version === 'v1') {
        const queryParams = new URLSearchParams();
        if (params.computeType)
          queryParams.append('computeType', params.computeType);
        if (params.gpuTypeId)
          params.gpuTypeId.forEach((type) =>
            queryParams.append('gpuTypeId', type)
          );
        if (params.dataCenterId)
          params.dataCenterId.forEach((dc) =>
            queryParams.append('dataCenterId', dc)
          );
        if (params.name) queryParams.append('name', params.name);
        if (params.includeMachine)
          queryParams.append(
            'includeMachine',
            params.includeMachine.toString()
          );
        if (params.includeNetworkVolume)
          queryParams.append(
            'includeNetworkVolume',
            params.includeNetworkVolume.toString()
          );
        queryString = queryParams.toString()
          ? `?${queryParams.toString()}`
          : '';
      }

      const result = await callRestUrl(
        `${backend.base}${backend.list}${queryString}`
      );

      return capListResult(backend.unwrap(result), {
        limit: params.limit,
        cursor: params.cursor,
      });
    }
  );

  // Get Pod Details
  server.tool(
    'get-pod',
    'Get full details for one pod by id, optionally expanding machine and attached network-volume info.',
    {
      podId: z.string().describe('ID of the pod to retrieve'),
      includeMachine: z
        .boolean()
        .optional()
        .describe('Include information about the machine'),
      includeNetworkVolume: z
        .boolean()
        .optional()
        .describe('Include information about attached network volumes'),
    },
    { title: 'Get pod', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('pods');

      // v1-only expansion query params (v2 has no query params on get).
      let queryString = '';
      if (backend.version === 'v1') {
        const queryParams = new URLSearchParams();
        if (params.includeMachine)
          queryParams.append(
            'includeMachine',
            params.includeMachine.toString()
          );
        if (params.includeNetworkVolume)
          queryParams.append(
            'includeNetworkVolume',
            params.includeNetworkVolume.toString()
          );
        queryString = queryParams.toString()
          ? `?${queryParams.toString()}`
          : '';
      }

      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.podId)}${queryString}`
      );
      return jsonReply(result);
    }
  );

  // Create Pod
  server.tool(
    'create-pod',
    'Create a new GPU/CPU pod on Runpod. Pass gpuTypeIds for a GPU pod, or computeType:"CPU" for a CPU pod (CPU pods are served by the v1 API for now). If the user does not specify an image, recommend the "Runpod Pytorch 2.8.0" image (runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404) as the default — it has the most up-to-date CUDA and PyTorch versions.',
    {
      name: z.string().optional().describe('Name for the pod'),
      imageName: z.string().describe('Docker image to use'),
      computeType: z
        .enum(['GPU', 'CPU'])
        .optional()
        .describe(
          "Pod type. On v2, required when not passing gpuTypeIds. 'CPU' is served by the v1 API for now (v2 has no CPU pods yet)."
        ),
      cloudType: z
        .enum(['SECURE', 'COMMUNITY'])
        .optional()
        .describe('SECURE or COMMUNITY cloud'),
      gpuTypeIds: z
        .array(z.string())
        .optional()
        .describe('List of acceptable GPU types'),
      gpuCount: z.number().optional().describe('Number of GPUs'),
      containerDiskInGb: z
        .number()
        .optional()
        .describe('Container disk size in GB'),
      volumeInGb: z.number().optional().describe('Volume size in GB'),
      volumeMountPath: z
        .string()
        .optional()
        .describe('Path to mount the volume'),
      ports: z
        .array(z.string())
        .optional()
        .describe("Ports to expose (e.g., '8888/http', '22/tcp')"),
      env: z.record(z.string()).optional().describe('Environment variables'),
      dataCenterIds: z
        .array(z.string())
        .optional()
        .describe('List of data centers'),
    },
    { title: 'Create pod', ...WRITE },
    async (params) => {
      const backend = backendFor('pods');

      // Pod type is decided by STATED intent, never inferred from the absence of
      // GPU fields (absence used to silently downgrade a misspecified GPU request
      // into a CPU pod). On v2 we require an explicit, non-contradictory choice;
      // v1 keeps its passthrough behavior (it validates the body itself).
      const hasGpuTypes = (params.gpuTypeIds?.length ?? 0) > 0;
      const hasGpuCount = (params.gpuCount ?? 0) > 0;
      const wantsCpu = params.computeType === 'CPU';
      const wantsGpu =
        hasGpuTypes || hasGpuCount || params.computeType === 'GPU';

      if (backend.version === 'v2') {
        if (wantsGpu && wantsCpu) {
          return jsonReply({
            error:
              "Specify a GPU pod (gpuTypeIds or computeType:'GPU') OR a CPU pod (computeType:'CPU'), not both.",
            status: 400,
          });
        }
        if (!wantsGpu && !wantsCpu) {
          return jsonReply({
            error:
              "No pod type specified. Pass gpuTypeIds (see list-gpu-types) for a GPU pod, or computeType:'CPU' for a CPU pod.",
            status: 400,
          });
        }
        if (wantsGpu && !hasGpuTypes) {
          return jsonReply({
            error:
              'A GPU pod needs gpuTypeIds (see list-gpu-types); gpuCount or computeType alone is under-specified.',
            status: 400,
          });
        }
        // v2 has no CPU pods yet (AE-2991): serve a CPU pod from v1 (which supports
        // them) instead of failing, and tell the caller which API answered.
        if (wantsCpu) {
          // v1 is a passthrough (mapCreate is identity there), so the raw tool
          // params are the correct v1 body — `computeType` is a valid v1 field.
          // Wrap the call so a v1 error surfaces as a clean message, not a raw
          // throw (matching the GPU/v2 path's error handling below).
          try {
            const result = (await callRestUrl(
              `${restV1Base(env)}/pods`,
              'POST',
              params as Record<string, unknown>
            )) as Record<string, unknown>;
            return jsonReply({
              ...result,
              _servedBy: 'v1',
              _note:
                'CPU pod: created on the v1 API, because the v2 REST API does not support CPU pods yet.',
            });
          } catch (error) {
            if (error instanceof HttpError) {
              return jsonReply({
                error: error.message,
                status: error.status,
                _servedBy: 'v1',
                _note: 'CPU pod create was routed to the v1 API and failed.',
              });
            }
            throw error;
          }
        }
      }

      const body = backend.mapCreate(params) as Record<string, unknown>;
      try {
        const result = (await callRestUrl(
          `${backend.base}${backend.list}`,
          'POST',
          body
        )) as Record<string, unknown>;
        // v2 accepts a single GPU type (`gpu.id`); v1's gpuTypeIds is "any of
        // these". If the caller offered several, only the first was sent — say
        // so in the reply so the narrowing isn't silent.
        if (
          backend.version === 'v2' &&
          (params.gpuTypeIds?.length ?? 0) > 1
        ) {
          return jsonReply({
            ...result,
            _warning: `v2 accepts one GPU type per pod; used "${params.gpuTypeIds![0]}" and ignored ${
              params.gpuTypeIds!.length - 1
            } other(s): ${params.gpuTypeIds!.slice(1).join(', ')}.`,
          });
        }
        return jsonReply(result);
      } catch (error) {
        // Defense for if/when the v2 CPU stub starts returning 501 directly
        // (AE-2991): surface a clean message instead of a raw stack.
        if (error instanceof HttpError && error.status === 501) {
          return jsonReply({
            error:
              'CPU pods are not yet supported on the v2 REST API. Use a GPU pod, or create the CPU pod via the v1 API (set RUNPOD_REST_VERSION=v1).',
            status: 501,
          });
        }
        throw error;
      }
    }
  );

  // Update Pod
  server.tool(
    'update-pod',
    "Update a pod's mutable fields (name, image, container disk, volume, ports, env). Only the fields you provide change.",
    {
      podId: z.string().describe('ID of the pod to update'),
      name: z.string().optional().describe('New name for the pod'),
      imageName: z.string().optional().describe('New Docker image'),
      containerDiskInGb: z
        .number()
        .optional()
        .describe('New container disk size in GB'),
      volumeInGb: z.number().optional().describe('New volume size in GB'),
      volumeMountPath: z
        .string()
        .optional()
        .describe('New path to mount the volume'),
      ports: z.array(z.string()).optional().describe('New ports to expose'),
      env: z
        .record(z.string())
        .optional()
        .describe('New environment variables'),
    },
    { title: 'Update pod', ...WRITE, idempotentHint: true },
    async (params) => {
      const { podId, ...updateParams } = params;
      const backend = backendFor('pods');
      const body = backend.mapUpdate(updateParams) as Record<string, unknown>;
      const result = await callRestUrl(
        `${backend.base}${backend.get!(podId)}`,
        'PATCH',
        body
      );
      return jsonReply(result);
    }
  );

  // Start Pod — v1: POST /pods/{id}/start ; v2: POST /pods/{id}/action {action:'start'}
  server.tool(
    'start-pod',
    'Start a stopped pod (resumes the same pod and its billing).',
    {
      podId: z.string().describe('ID of the pod to start'),
    },
    { title: 'Start pod', ...WRITE, idempotentHint: true },
    async (params) => {
      const result = await podAction(params.podId, 'start');
      return jsonReply(result);
    }
  );

  // Stop Pod — v1: POST /pods/{id}/stop ; v2: POST /pods/{id}/action {action:'stop'}
  server.tool(
    'stop-pod',
    'Stop a running pod. The pod and its disk persist; GPU billing stops.',
    {
      podId: z.string().describe('ID of the pod to stop'),
    },
    { title: 'Stop pod', ...WRITE, idempotentHint: true },
    async (params) => {
      const result = await podAction(params.podId, 'stop');
      return jsonReply(result);
    }
  );

  // Restart Pod — v2-only state transition (PodAction enum). The v1 REST API has
  // no restart endpoint, so under v1 we return a clean message instead of firing
  // a request that would 404 (mirrors the create-pod 501 handling).
  server.tool(
    'restart-pod',
    'Restart a running pod (single PodAction call). v2-only — on the v1 API returns a 501 notice (stop then start the pod instead).',
    {
      podId: z.string().describe('ID of the pod to restart'),
    },
    { title: 'Restart pod', ...WRITE },
    async (params) => {
      const backend = backendFor('pods');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'restart-pod is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2 (or stop then start the pod on v1).',
          status: 501,
        });
      }
      const result = await podAction(params.podId, 'restart');
      return jsonReply(result);
    }
  );

  // Stream Pod Logs — v2-only (GET /v2/pods/{id}/logs, text/event-stream).
  // The endpoint streams live container/system log lines as SSE. Because a live
  // stream never ends on its own, we read it time-bounded (maxWaitMs) and
  // byte-capped, then return the collected lines as a JSON array — so a one-shot
  // MCP tool call gets a bounded snapshot rather than hanging. v1 has no logs
  // endpoint → 501 notice.
  server.tool(
    'stream-pod-logs',
    'Fetch a bounded snapshot of a pod\'s live logs (container and/or system) via Server-Sent Events. v2-only — returns a 501 notice on the v1 API. Reads for up to maxWaitMs (default 5s) and returns the collected log lines; use `tail` to backfill recent lines first. Large output is truncated (see the `truncated` flag).',
    {
      podId: z.string().describe('ID of the pod whose logs to stream'),
      source: z
        .enum(['container', 'system', 'both'])
        .optional()
        .describe('Which log source to read (default: both)'),
      tail: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Number of recent lines to backfill before live output'),
      maxWaitMs: z
        .number()
        .int()
        .min(500)
        .max(30000)
        .optional()
        .describe('How long to read the stream, in ms (default 5000, max 30000)'),
    },
    { title: 'Stream pod logs', ...READ_ONLY },
    async (params) => {
      const backend = backendFor('pods');
      if (backend.version === 'v1') {
        return jsonReply({
          error:
            'stream-pod-logs is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.',
          status: 501,
        });
      }
      const qs = new URLSearchParams();
      if (params.source) qs.append('source', params.source);
      if (params.tail !== undefined) qs.append('tail', String(params.tail));
      const queryString = qs.toString() ? `?${qs.toString()}` : '';
      try {
        const { raw, truncated } = await streamSse(
          `${backend.base}${backend.get!(params.podId)}/logs${queryString}`,
          { maxWaitMs: params.maxWaitMs ?? 5000, maxBytes: 256 * 1024 }
        );
        const items = parsePodLogSse(raw);
        return jsonReply({ items, count: items.length, truncated });
      } catch (error) {
        if (error instanceof HttpError) {
          return jsonReply({ error: error.message, status: error.status });
        }
        throw error;
      }
    }
  );

  // Delete Pod
  server.tool(
    'delete-pod',
    'Permanently delete a pod and its data. This cannot be undone.',
    {
      podId: z.string().describe('ID of the pod to delete'),
    },
    { title: 'Delete pod', ...DESTRUCTIVE },
    async (params) => {
      const backend = backendFor('pods');
      const result = await callRestUrl(
        `${backend.base}${backend.get!(params.podId)}`,
        'DELETE'
      );
      return jsonReply(result);
    }
  );
}
