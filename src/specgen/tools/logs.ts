// Curated log tools. Pod logs (GET /v2/pods/{id}/logs) and worker logs
// (GET /v2/serverless/{id}/workers/{workerId}/logs) are the same feature on
// two resources: an SSE stream of `data: {source,line,ts}` frames that stays
// open to tail live output. The generated JSON dispatch cannot consume
// text/event-stream, so both operations are excluded in generator-config.yaml
// and served here as bounded snapshots instead.

import { DEFAULT_BASE_URL } from '@runpod/sdk';
import type { CuratedTool } from '../server.js';
import { collectLogSnapshot, type LogSnapshotParams } from '../clients/sse.js';
import { ok, runTool } from './util.js';

const logStreamProperties = {
  source: {
    type: 'string',
    enum: ['container', 'system', 'both'],
    description: 'Which log source to read (default: both)',
  },
  tail: {
    type: 'integer',
    minimum: 0,
    maximum: 5000,
    description:
      'Historical lines to backfill before live output (API default 100, max 5000; 0 = live only). Ignored when `since` is set.',
  },
  since: {
    type: 'string',
    description:
      'RFC3339 timestamp to resume from; when set, `tail` is ignored.',
  },
  maxWaitMs: {
    type: 'integer',
    minimum: 500,
    maximum: 30000,
    description: 'How long to read the stream, in ms (default 5000, max 30000)',
  },
} as const;

function baseUrl(): string {
  return process.env.RUNPOD_API_BASE_URL ?? DEFAULT_BASE_URL;
}

export const streamPodLogs: CuratedTool = {
  name: 'stream-pod-logs',
  description:
    "Read a bounded snapshot of a Pod's logs (container and/or system source). Holds the live stream open for maxWaitMs and returns the parsed log lines; `truncated: true` means the byte cap cut the output. Use `since` to resume from a timestamp.",
  inputSchema: {
    type: 'object',
    properties: {
      podId: { type: 'string', description: 'ID of the Pod to read logs from' },
      ...logStreamProperties,
    },
    required: ['podId'],
  },
  handler: (ctx, args) =>
    runTool(async () =>
      ok(
        await collectLogSnapshot(
          ctx.sse,
          `${baseUrl()}/v2/pods/${encodeURIComponent(args.podId as string)}/logs`,
          args as LogSnapshotParams
        )
      )
    ),
};

export const streamWorkerLogs: CuratedTool = {
  name: 'stream-worker-logs',
  description:
    "Read a bounded snapshot of a Serverless worker's logs (container and/or system source). Holds the live stream open for maxWaitMs and returns the parsed log lines; `truncated: true` means the byte cap cut the output. Get worker IDs from list-endpoint-workers; use this to inspect UNHEALTHY (crash-looping) workers.",
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        type: 'string',
        description: 'ID of the Serverless endpoint the worker belongs to',
      },
      workerId: {
        type: 'string',
        description: 'ID of the worker to read logs from',
      },
      ...logStreamProperties,
    },
    required: ['endpointId', 'workerId'],
  },
  handler: (ctx, args) =>
    runTool(async () =>
      ok(
        await collectLogSnapshot(
          ctx.sse,
          `${baseUrl()}/v2/serverless/${encodeURIComponent(args.endpointId as string)}/workers/${encodeURIComponent(args.workerId as string)}/logs`,
          args as LogSnapshotParams
        )
      )
    ),
};

export const logTools: CuratedTool[] = [streamPodLogs, streamWorkerLogs];
