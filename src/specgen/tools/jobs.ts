// Curated tools for the Serverless runtime plane (job submission and
// lifecycle at api.runpod.ai/v2/{endpointId}/...). Runpod publishes no OpenAPI
// document for this plane, so these cannot be generated from the v2 spec;
// behavior is ported from the official MCP server (Apache-2.0,
// runpod/runpod-mcp). Two transports serve these tools: local stdio
// (5-minute wait budgets) and the hosted Vercel path, where the 60s gateway
// reaper clamps every hold to HTTP_LONG_POLL_BUDGET_MS (see HOSTED below).

import type { CuratedTool } from '../server.js';
import type { ToolContext } from '../context.js';
import { badRequest, ok, runTool } from './util.js';

const ID_PATTERN = '^[a-zA-Z0-9_-]+$';
const ID_REGEX = new RegExp(ID_PATTERN);

// Upstream default the server applies when no ?wait= is sent on /runsync.
const RUNSYNC_UPSTREAM_DEFAULT_WAIT_MS = 90_000;
// Client deadline slack on top of the wait the server was asked to hold — a
// deadline at the hold aborts the reply we are waiting for.
const UPSTREAM_HOLD_SLACK_MS = 5_000;

// stream-job polling: total budget, what an empty /stream holds for when no
// ?wait= is sent (the stdio path omits the query), per-poll floor, pause
// between polls, and the consecutive-error cap that ends the run.
// Hosted (Vercel) requests are reaped at 60s (vercel.json maxDuration), so
// every server-side hold clamps to 45s there — the response must serialize
// before the platform kills the invocation. stdio keeps the 5-minute budgets.
export const HOSTED = process.env.VERCEL === '1';
export const HTTP_LONG_POLL_BUDGET_MS = 45_000;
export const STREAM_BUDGET_MS = HOSTED
  ? HTTP_LONG_POLL_BUDGET_MS
  : 5 * 60 * 1000;
const STREAM_UPSTREAM_DEFAULT_WAIT_MS = 10_000;
const MIN_STREAM_POLL_TIMEOUT_MS = 2_000;
const STREAM_JOB_POLL_INTERVAL_MS = 1_000;
export const MAX_CONSECUTIVE_STREAM_ERRORS = 5;

// get-job-status server-side wait: the ceiling on a single blocking call and
// the pause between /status polls inside it. /status returns instantly (it
// does not hold like /stream), so blocking through a cold start means polling
// it here rather than making the agent tight-loop the tool — a turn-burn that
// never advances wall-clock. Ceiling matches runsync's 5-minute wait cap.
export const STATUS_WAIT_MAX_MS = HOSTED
  ? HTTP_LONG_POLL_BUDGET_MS
  : 5 * 60 * 1000;
const STATUS_POLL_INTERVAL_MS = 4_000;

const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);

const RESUME_ADVICE =
  'Call stream-job again to continue collecting output, get-job-status to check the job without streaming, or stream without a budget by calling the runtime API directly (GET https://api.runpod.ai/v2/{endpointId}/stream/{jobId} with a Bearer API key).';

function formatBudget(ms: number): string {
  return ms < 120_000
    ? `${Math.round(ms / 1000)} seconds`
    : `${Math.round(ms / 60_000)} minutes`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

// Deadline for ONE /stream poll: the hold it brackets plus slack, bounded by
// what is left of the budget, never below the floor (so the last poll of a
// nearly-spent budget can still answer) — and never the whole budget (one
// wedged socket must not eat the run before the error cap can engage).
export function streamPollTimeoutMs(
  remainingMs: number,
  holdMs: number
): number {
  return Math.max(
    Math.min(remainingMs, holdMs + UPSTREAM_HOLD_SLACK_MS),
    MIN_STREAM_POLL_TIMEOUT_MS
  );
}

// One polling driver for both wait loops (/stream and /status): poll until a
// terminal status, the budget runs out, or the API fails
// MAX_CONSECUTIVE_STREAM_ERRORS times IN A ROW. Only consecutive failures end
// the run, and the error reported at the end is one still happening at the
// end. The callers differ only in how each poll's deadline derives from the
// remaining budget, the cadence, and the advice attached to a non-terminal
// exit.
async function pollUntilTerminal(deps: {
  poll: (timeoutMs: number) => Promise<Record<string, unknown>>;
  budgetMs: number;
  // Deadline for ONE poll, derived from the budget's remaining ms.
  timeoutFor: (remainingMs: number) => number;
  pollIntervalMs: number;
  // Advice strings for the two non-terminal exits.
  abortedNote: string;
  timedOutNote: string;
  // Chunk collection seam (/stream); called on every successful reply.
  onReply?: (reply: Record<string, unknown>) => void;
}): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  let result: Record<string, unknown> = {};
  let consecutiveErrors = 0;
  let lastError: string | undefined;

  while (true) {
    try {
      const reply = await deps.poll(deps.timeoutFor(deps.budgetMs - elapsed()));
      consecutiveErrors = 0;
      lastError = undefined;
      deps.onReply?.(reply);
      result = reply;
      if (TERMINAL_STATUSES.has(reply.status as string)) return result;
    } catch (error) {
      consecutiveErrors++;
      lastError = error instanceof Error ? error.message : String(error);
      if (consecutiveErrors >= MAX_CONSECUTIVE_STREAM_ERRORS) {
        return {
          ...result,
          error: `Polling aborted after ${MAX_CONSECUTIVE_STREAM_ERRORS} consecutive errors: ${lastError}`,
          note: deps.abortedNote,
        };
      }
    }

    if (elapsed() > deps.budgetMs) {
      return {
        ...result,
        pollingTimedOut: true,
        note: deps.timedOutNote,
        ...(lastError ? { lastError } : {}),
      };
    }

    await sleep(deps.pollIntervalMs);
  }
}

// Exported so a test can drive the loop through `poll` without a server.
export async function collectJobStream(deps: {
  poll: (timeoutMs: number) => Promise<Record<string, unknown>>;
  budgetMs: number;
  holdMs: number;
  pollIntervalMs?: number;
}): Promise<{ result: Record<string, unknown>; chunks: unknown[] }> {
  const chunks: unknown[] = [];
  const result = await pollUntilTerminal({
    poll: deps.poll,
    budgetMs: deps.budgetMs,
    timeoutFor: (remainingMs) => streamPollTimeoutMs(remainingMs, deps.holdMs),
    pollIntervalMs: deps.pollIntervalMs ?? STREAM_JOB_POLL_INTERVAL_MS,
    abortedNote: `Polling stopped after ${MAX_CONSECUTIVE_STREAM_ERRORS} consecutive errors with the job possibly still running. ${RESUME_ADVICE}`,
    timedOutNote: `Polling stopped after ${formatBudget(deps.budgetMs)} with the job possibly still running. ${RESUME_ADVICE}`,
    onReply: (reply) => {
      if (Array.isArray(reply.stream)) chunks.push(...reply.stream);
    },
  });
  return { result, chunks };
}

// Block on a job by polling /status until it reaches a terminal status, the
// wait budget runs out, or the API fails MAX_CONSECUTIVE_STREAM_ERRORS times in
// a row. /status returns instantly, so the hold lives here, not on the server.
// Exported so a test can drive the loop through `fetchStatus` without a server.
export async function pollJobStatus(deps: {
  fetchStatus: (timeoutMs: number) => Promise<Record<string, unknown>>;
  budgetMs: number;
  pollIntervalMs?: number;
}): Promise<Record<string, unknown>> {
  return pollUntilTerminal({
    poll: deps.fetchStatus,
    budgetMs: deps.budgetMs,
    // One /status call may not outlive the budget: unbounded, a hung socket
    // holds the request past the hosted 60s reaper (the client default is
    // 30s, which a poll started at 44s of a 45s budget would exceed) — but
    // never below the floor, so the last poll of a nearly-spent budget can
    // still answer.
    timeoutFor: (remainingMs) =>
      Math.max(remainingMs, MIN_STREAM_POLL_TIMEOUT_MS),
    pollIntervalMs: deps.pollIntervalMs ?? STATUS_POLL_INTERVAL_MS,
    abortedNote:
      'Polling stopped after repeated errors with the job possibly still running. Call get-job-status again to keep checking.',
    timedOutNote: `Still not terminal after waiting ${formatBudget(deps.budgetMs)} — a first-job cold start (image pull + model load) can take several minutes. Call get-job-status again (with wait) to keep blocking, or check back without waiting.`,
  });
}

// A job stuck IN_QUEUE has two very different causes its status alone cannot
// distinguish: no host has the endpoint's GPU available (capacity), or a
// worker DID spin up and is crash-looping — the platform marks it UNHEALTHY
// while the job stays queued. Agents read the endless IN_QUEUE as "no
// capacity" and stop digging, so get-job-status best-effort attaches the
// endpoint's worker summary and a hint. Never fails the status call itself.
interface WorkerSummary {
  idle?: number;
  initializing?: number;
  running?: number;
  throttled?: number;
  total?: number;
  unhealthy?: number;
}

// Cost controls ported from the official server (runpod/runpod-mcp): a stuck
// job is polled repeatedly against the SAME endpoint, so a short TTL cache
// makes the extra round trip effectively free across a poll loop, and a
// dedicated timeout stops a slow /workers call from eating into the caller's
// budget. Together these are what make diagnosing on every IN_QUEUE — v1's
// behavior — affordable on the hosted path.
const DIAGNOSIS_TTL_MS = 15_000;
const MAX_DIAGNOSIS_ENTRIES = 500;
export const QUEUED_DIAGNOSIS_TIMEOUT_MS = 5_000;

interface CachedDiagnosis {
  value: { workerHealth: WorkerSummary; hint: string };
  expiresAt: number;
}
const diagnosisCache = new Map<string, CachedDiagnosis>();

async function diagnoseQueuedJob(
  ctx: ToolContext,
  endpointId: string
): Promise<{ workerHealth: WorkerSummary; hint: string } | null> {
  const cached = diagnosisCache.get(endpointId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  diagnosisCache.delete(endpointId);

  const remember = (value: { workerHealth: WorkerSummary; hint: string }) => {
    if (diagnosisCache.size >= MAX_DIAGNOSIS_ENTRIES) {
      const oldest = diagnosisCache.keys().next().value;
      if (oldest !== undefined) diagnosisCache.delete(oldest);
    }
    diagnosisCache.set(endpointId, {
      value,
      expiresAt: Date.now() + DIAGNOSIS_TTL_MS,
    });
    return value;
  };

  // Explicit controller + ref'd timer, not AbortSignal.timeout: that timer is
  // unref'd and never fires on an otherwise idle loop (see bounded-fetch.ts).
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    QUEUED_DIAGNOSIS_TIMEOUT_MS
  );
  try {
    const { data, error } = await ctx.sdk.GET('/v2/serverless/{id}/workers', {
      params: { path: { id: endpointId } },
      signal: controller.signal,
    });
    if (error !== undefined || !data) return null;
    const summary = (data as { summary?: WorkerSummary }).summary;
    const workers =
      (data as { workers?: Array<{ id: string; status?: string }> }).workers ??
      [];
    if (!summary) return null;

    if ((summary.unhealthy ?? 0) > 0) {
      const badIds = workers
        .filter((w) => w.status === 'UNHEALTHY')
        .map((w) => w.id)
        .join(', ');
      return remember({
        workerHealth: summary,
        hint: `${summary.unhealthy} of ${summary.total} worker(s) on this endpoint are UNHEALTHY — the container is likely crash-looping (repeated starts that exit before the handler runs). The job can stay IN_QUEUE indefinitely; this is a worker failure, NOT a capacity shortage. Inspect the logs with stream-worker-logs${badIds ? ` (workerId: ${badIds})` : ''}.`,
      });
    }
    if ((summary.total ?? 0) === 0) {
      return remember({
        workerHealth: summary,
        hint: 'No workers are scheduled for this endpoint yet — it may simply be scaling up from zero (normal for the first seconds of a cold start), or it is waiting for GPU capacity / its GPU-CUDA constraints exclude the currently-available hosts. If this persists, check availability with get-capacity or widen the GPU/CUDA settings.',
      });
    }
    if ((summary.throttled ?? 0) > 0 && (summary.running ?? 0) === 0) {
      return remember({
        workerHealth: summary,
        hint: 'Workers exist but are throttled — the hosts are at capacity right now; the job should start when capacity frees up.',
      });
    }
    if ((summary.initializing ?? 0) > 0) {
      return remember({
        workerHealth: summary,
        hint: 'A worker is initializing — likely a cold start (image pull / model load); the job should start soon.',
      });
    }
    return remember({ workerHealth: summary, hint: '' });
  } catch {
    return null; // diagnosis is best-effort — never break the status call
  } finally {
    clearTimeout(timer);
  }
}

const endpointIdProperty = {
  type: 'string',
  pattern: ID_PATTERN,
  description: 'ID of the Serverless endpoint',
} as const;

const jobIdProperty = {
  type: 'string',
  pattern: ID_PATTERN,
  description: 'ID of the job',
} as const;

const inputProperty = {
  type: 'object',
  additionalProperties: true,
  description:
    'Input payload for the worker handler. The expected fields depend on the deployed model or worker.',
} as const;

const webhookProperty = {
  type: 'string',
  description:
    'Webhook URL to receive job completion notifications instead of polling',
} as const;

const policyProperty = {
  type: 'object',
  description: 'Execution policy options',
  properties: {
    executionTimeout: {
      type: 'number',
      description: 'Maximum execution time in milliseconds',
    },
    lowPriority: {
      type: 'boolean',
      description: 'Submit as a low-priority job',
    },
    ttl: {
      type: 'number',
      description: 'Time-to-live for the job result in milliseconds',
    },
  },
} as const;

const s3ConfigProperty = {
  type: 'object',
  description: 'S3-compatible storage config for large outputs',
  properties: {
    accessId: { type: 'string', description: 'S3 access key ID' },
    accessSecret: { type: 'string', description: 'S3 secret access key' },
    bucketName: { type: 'string', description: 'S3 bucket name' },
    endpointUrl: { type: 'string', description: 'S3 endpoint URL' },
  },
  required: ['accessId', 'accessSecret', 'bucketName', 'endpointUrl'],
} as const;

function requireIds(
  args: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value !== 'string' || !ID_REGEX.test(value)) {
      return `${key} must be a string matching ${ID_PATTERN}`;
    }
  }
  return null;
}

export const runEndpoint: CuratedTool = {
  name: 'run-endpoint',
  description:
    'Submit an asynchronous job to a Serverless endpoint. Returns a job ID immediately — use get-job-status to poll for results (pass its `wait` to block through a cold start instead of tight-looping). Async results are available for 30 minutes after completion.',
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        ...endpointIdProperty,
        description: 'ID of the Serverless endpoint to run',
      },
      input: inputProperty,
      webhook: webhookProperty,
      policy: policyProperty,
      s3Config: s3ConfigProperty,
    },
    required: ['endpointId', 'input'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const invalid = requireIds(args, ['endpointId']);
      if (invalid) return badRequest(invalid);
      const { endpointId, ...body } = args;
      return ok(
        await ctx.runtime(endpointId as string, '/run', {
          method: 'POST',
          body: body as Record<string, unknown>,
        })
      );
    }),
};

export const runsyncEndpoint: CuratedTool = {
  name: 'runsync-endpoint',
  description:
    'Submit a synchronous job to a Serverless endpoint and wait for the result. Best for fast tasks: if the job outlives the wait, the response returns a job ID and a non-terminal status (IN_QUEUE or IN_PROGRESS) to poll with get-job-status. Max payload 20 MB; results expire after 1 minute. The wait parameter extends the server-side wait' +
    (HOSTED
      ? ` — this server runs behind a 60-second gateway deadline, so waits clamp to ${HTTP_LONG_POLL_BUDGET_MS} ms, which is also the effective default. For longer jobs use run-endpoint + get-job-status.`
      : ' to up to 5 minutes (300000 ms); it defaults to 90000 (90 seconds).'),
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        ...endpointIdProperty,
        description: 'ID of the Serverless endpoint to run synchronously',
      },
      input: inputProperty,
      wait: {
        type: 'number',
        minimum: 1000,
        maximum: HOSTED ? HTTP_LONG_POLL_BUDGET_MS : 300000,
        description: HOSTED
          ? `How long in milliseconds the server should wait for a result (1000–${HTTP_LONG_POLL_BUDGET_MS}; higher values clamp to ${HTTP_LONG_POLL_BUDGET_MS}, the gateway ceiling).`
          : 'How long in milliseconds the server should wait for a result before returning a job ID to poll (1000–300000). Defaults to 90000 (90 seconds).',
      },
      webhook: webhookProperty,
      policy: policyProperty,
      s3Config: s3ConfigProperty,
    },
    required: ['endpointId', 'input'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const invalid = requireIds(args, ['endpointId']);
      if (invalid) return badRequest(invalid);
      const { endpointId, wait, ...body } = args;
      // Hosted: an omitted wait inherits the upstream 90s hold, which outlives
      // the 60s platform reaper — send an explicit clamped wait instead.
      const requested = wait as number | undefined;
      const clamped = HOSTED
        ? Math.min(
            requested ?? HTTP_LONG_POLL_BUDGET_MS,
            HTTP_LONG_POLL_BUDGET_MS
          )
        : requested;
      // undefined, not falsy: `wait: 0` would drop the query and inherit the
      // upstream 90s default silently.
      const waitQuery = clamped === undefined ? '' : `?wait=${clamped}`;
      return ok(
        await ctx.runtime(endpointId as string, `/runsync${waitQuery}`, {
          method: 'POST',
          body: body as Record<string, unknown>,
          // The client deadline must outlast the wait the server was asked to
          // hold, or we abort the reply we are waiting for.
          timeoutMs:
            (clamped ?? RUNSYNC_UPSTREAM_DEFAULT_WAIT_MS) +
            UPSTREAM_HOLD_SLACK_MS,
        })
      );
    }),
};

export const getJobStatus: CuratedTool = {
  name: 'get-job-status',
  description:
    'Check the status of a Serverless job. Returns the current status and output when complete. Job statuses: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, CANCELLED, TIMED_OUT. Pass `wait` (milliseconds, up to ' +
    STATUS_WAIT_MAX_MS +
    ') to BLOCK server-side, polling until the job reaches a terminal status or the budget expires — use it to ride out a cold start (a first job on a fresh worker pulls the image and loads the model, commonly 1–5+ minutes) in a single call instead of returning on the first IN_QUEUE and tight-looping the tool. Without `wait` it returns the current status immediately (a single check). If the budget expires before a terminal status, it returns the latest non-terminal status with pollingTimedOut:true — call again (with `wait`) to keep blocking. IMPORTANT: a job stuck IN_QUEUE does not necessarily mean a capacity shortage — a worker may have spun up and crash-looped (the platform marks it UNHEALTHY while the job stays queued). When the job is IN_QUEUE this tool attaches a workerHealth summary and a hint; to dig deeper, call list-endpoint-workers (look for UNHEALTHY) and stream-worker-logs.',
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        ...endpointIdProperty,
        description: 'ID of the Serverless endpoint the job belongs to',
      },
      jobId: { ...jobIdProperty, description: 'ID of the job to check' },
      wait: {
        type: 'number',
        minimum: 1000,
        maximum: STATUS_WAIT_MAX_MS,
        description: `How long in milliseconds to block server-side, polling the job until it reaches a terminal status (1000–${STATUS_WAIT_MAX_MS}). Omit for a single immediate check. Use this to wait through a cold start rather than tight-looping the tool.`,
      },
    },
    required: ['endpointId', 'jobId'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const invalid = requireIds(args, ['endpointId', 'jobId']);
      if (invalid) return badRequest(invalid);
      const endpointId = args.endpointId as string;
      const jobId = args.jobId as string;
      const fetchStatus = (timeoutMs?: number) =>
        ctx.runtime(endpointId, `/status/${jobId}`, {
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }) as Promise<Record<string, unknown>>;
      const result =
        args.wait === undefined
          ? await fetchStatus()
          : await pollJobStatus({
              fetchStatus,
              budgetMs: Math.min(args.wait as number, STATUS_WAIT_MAX_MS),
            });
      if (
        result &&
        typeof result === 'object' &&
        (result as { status?: string }).status === 'IN_QUEUE'
      ) {
        const diagnosis = await diagnoseQueuedJob(ctx, endpointId);
        if (diagnosis) {
          return ok({
            ...(result as Record<string, unknown>),
            workerHealth: diagnosis.workerHealth,
            ...(diagnosis.hint ? { hint: diagnosis.hint } : {}),
          });
        }
      }
      return ok(result);
    }),
};

export const streamJob: CuratedTool = {
  name: 'stream-job',
  description: `Retrieve streaming output from a Serverless job. The worker must support streaming output. Polls /stream/{jobId} and collects chunks until the status is COMPLETED, FAILED, CANCELLED, or TIMED_OUT, for up to ${formatBudget(STREAM_BUDGET_MS)}. If the budget expires first, returns the chunks collected so far with pollingTimedOut: true — call stream-job again to resume where it left off, or get-job-status to check without streaming.`,
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        ...endpointIdProperty,
        description: 'ID of the Serverless endpoint the job belongs to',
      },
      jobId: {
        ...jobIdProperty,
        description: 'ID of the job to stream results from',
      },
    },
    required: ['endpointId', 'jobId'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const invalid = requireIds(args, ['endpointId', 'jobId']);
      if (invalid) return badRequest(invalid);
      const { result, chunks } = await collectJobStream({
        budgetMs: STREAM_BUDGET_MS,
        holdMs: STREAM_UPSTREAM_DEFAULT_WAIT_MS,
        poll: (timeoutMs) =>
          ctx.runtime(args.endpointId as string, `/stream/${args.jobId}`, {
            timeoutMs,
          }) as Promise<Record<string, unknown>>,
      });
      return ok({ ...result, stream: chunks });
    }),
};

export const cancelJob: CuratedTool = {
  name: 'cancel-job',
  description: 'Cancel a Serverless job that is queued or in progress.',
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        ...endpointIdProperty,
        description: 'ID of the Serverless endpoint the job belongs to',
      },
      jobId: { ...jobIdProperty, description: 'ID of the job to cancel' },
    },
    required: ['endpointId', 'jobId'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const invalid = requireIds(args, ['endpointId', 'jobId']);
      if (invalid) return badRequest(invalid);
      return ok(
        await ctx.runtime(args.endpointId as string, `/cancel/${args.jobId}`, {
          method: 'POST',
        })
      );
    }),
};

export const retryJob: CuratedTool = {
  name: 'retry-job',
  description:
    'Retry a failed or timed-out Serverless job. Only works for jobs with FAILED or TIMED_OUT status. The previous output is removed and the job is requeued.',
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        ...endpointIdProperty,
        description: 'ID of the Serverless endpoint the job belongs to',
      },
      jobId: { ...jobIdProperty, description: 'ID of the job to retry' },
    },
    required: ['endpointId', 'jobId'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const invalid = requireIds(args, ['endpointId', 'jobId']);
      if (invalid) return badRequest(invalid);
      return ok(
        await ctx.runtime(args.endpointId as string, `/retry/${args.jobId}`, {
          method: 'POST',
        })
      );
    }),
};

export const endpointHealth: CuratedTool = {
  name: 'endpoint-health',
  description:
    'Get the endpoint-level health rollup for a Serverless endpoint: worker counts by state plus job queue statistics. This is the runtime plane\'s own /health view and it can lag or disagree with the per-worker truth — when a job is stuck IN_QUEUE, treat list-endpoint-workers as the authority on whether a worker is UNHEALTHY (crash-looping container; read it with stream-worker-logs), and note that get-job-status already attaches that worker summary and a hint on every IN_QUEUE result. Zero workers here means the endpoint is waiting for GPU capacity.',
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        ...endpointIdProperty,
        description: 'ID of the Serverless endpoint to check health for',
      },
    },
    required: ['endpointId'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const invalid = requireIds(args, ['endpointId']);
      if (invalid) return badRequest(invalid);
      return ok(await ctx.runtime(args.endpointId as string, '/health'));
    }),
};

export const purgeEndpointQueue: CuratedTool = {
  name: 'purge-endpoint-queue',
  description:
    'Remove all pending jobs from a Serverless endpoint queue. Only affects queued jobs — in-progress jobs continue running. Use this for error recovery or clearing outdated requests.',
  inputSchema: {
    type: 'object',
    properties: {
      endpointId: {
        ...endpointIdProperty,
        description: 'ID of the Serverless endpoint to purge the queue for',
      },
    },
    required: ['endpointId'],
  },
  handler: (ctx, args) =>
    runTool(async () => {
      const invalid = requireIds(args, ['endpointId']);
      if (invalid) return badRequest(invalid);
      return ok(
        await ctx.runtime(args.endpointId as string, '/purge-queue', {
          method: 'POST',
        })
      );
    }),
};

export const jobTools: CuratedTool[] = [
  runEndpoint,
  runsyncEndpoint,
  getJobStatus,
  streamJob,
  cancelJob,
  retryJob,
  endpointHealth,
  purgeEndpointQueue,
];
