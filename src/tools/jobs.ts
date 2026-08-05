import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ONLY, WRITE, type ToolRuntime } from './runtime.js';

// ============== SERVERLESS RUNTIME TOOLS ==============
// Job submission and lifecycle against the Serverless runtime API
// (api.runpod.ai/v2/{endpointId}/...). Distinct from endpoint CRUD.

// Agents poll get-job-status in a tight loop while a job is queued, and each
// IN_QUEUE poll would otherwise refetch the same worker list — dozens of
// identical diagnoses for one queued job. Worker state changes on the order of
// tens of seconds (scheduling, container starts), so a short-lived cache keyed
// by endpoint keeps the amplification at one extra call per endpoint per TTL.
// Module-level so it survives across per-request tool registries on a warm
// hosted instance; bounded so one-off endpoint ids cannot grow it unbounded.
const DIAGNOSIS_TTL_MS = 15_000;
const MAX_DIAGNOSIS_ENTRIES = 500;
interface CachedDiagnosis {
  value: { workerHealth: unknown; hint: string };
  expiresAt: number;
}
const diagnosisCache = new Map<string, CachedDiagnosis>();
// Test seam: module-level state would otherwise leak between test cases.
export function clearQueuedJobDiagnosisCache(): void {
  diagnosisCache.clear();
}

// Vercel kills the hosted server's function at 60s (vercel.json maxDuration).
// A tool that plans to wait longer never reaches its own graceful-timeout path:
// the platform reaps it first, so the client gets a bare 504, everything
// collected so far is discarded, and the function stays billed for the full 60s.
// Every long-poll budget below is therefore clamped on 'http', leaving room for
// the credential pre-flight. stdio has no deadline and keeps the full budgets.
const HTTP_LONG_POLL_BUDGET_MS = 45_000;
// What /runsync waits when the request omits `wait` — the value we clamp against.
const RUNSYNC_UPSTREAM_DEFAULT_WAIT_MS = 90_000;
// How long an http /stream poll lets the server hold an empty response. Without
// it the server blocks for its own 10s default, and since the budget is only
// checked between polls a chunk-sparse job overshoots 45s to ~54s. The endpoint
// accepts 1000–300000.
const HTTP_STREAM_POLL_WAIT_MS = 1000;

// Budgets are round minutes above two of them ("5 minutes"), matching how the
// tool descriptions state them, and seconds below.
function formatBudget(ms: number): string {
  return ms >= 120_000
    ? `${Math.round(ms / 60_000)} minutes`
    : `${Math.round(ms / 1000)} seconds`;
}

export function registerJobTools(server: McpServer, rt: ToolRuntime): void {
  const { jsonReply, serverlessRequest, backendFor, callRestUrl } = rt;

  // A job stuck IN_QUEUE has two very different causes that its status alone
  // cannot distinguish: no host has the endpoint's GPU available (capacity),
  // or a worker DID spin up and is crash-looping — the platform marks it
  // UNHEALTHY while the job stays queued forever. Field experience shows
  // agents (and humans) read the endless IN_QUEUE as "no capacity" and stop
  // digging. So when get-job-status sees IN_QUEUE, it best-effort attaches the
  // endpoint's worker summary and a plain-language hint pointing at the next
  // diagnostic step. v2-only (the workers listing has no v1 REST home);
  // never fails the status call itself.
  interface WorkerSummary {
    idle?: number;
    initializing?: number;
    running?: number;
    throttled?: number;
    total?: number;
    unhealthy?: number;
  }

  async function diagnoseQueuedJob(
    endpointId: string
  ): Promise<{ workerHealth: WorkerSummary; hint: string } | null> {
    const cached = diagnosisCache.get(endpointId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value as { workerHealth: WorkerSummary; hint: string };
    }
    diagnosisCache.delete(endpointId);
    try {
      const backend = backendFor('workers');
      if (backend.version !== 'v2') return null;
      const raw = (await callRestUrl(
        `${backend.base}/serverless/${endpointId}/workers`
      )) as
        | {
            summary?: WorkerSummary;
            workers?: Array<{ id: string; status?: string }>;
          }
        | undefined;
      const summary = raw?.summary;
      const workers = raw?.workers ?? [];
      if (!summary) return null;

      const remember = (value: {
        workerHealth: WorkerSummary;
        hint: string;
      }) => {
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

      if ((summary.unhealthy ?? 0) > 0) {
        const badIds = workers
          .filter((w) => w.status === 'UNHEALTHY')
          .map((w) => w.id)
          .join(', ');
        return remember({
          workerHealth: summary,
          hint: `${summary.unhealthy} of ${summary.total} worker(s) on this endpoint are UNHEALTHY — the container is likely crash-looping (repeated starts that exit before the handler runs). The job can stay IN_QUEUE indefinitely; this is a worker failure, NOT a capacity shortage. Inspect the logs with stream-worker-logs${
            badIds ? ` (workerId: ${badIds})` : ''
          }.`,
        });
      }
      if ((summary.total ?? 0) === 0) {
        return remember({
          workerHealth: summary,
          hint: 'No workers are scheduled for this endpoint yet — it may simply be scaling up from zero (normal for the first seconds of a cold start), or it is waiting for GPU capacity / its GPU-CUDA constraints exclude the currently-available hosts. If this persists, check availability with list-gpu-types or widen the gpuIds/CUDA settings.',
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
    }
  }

  // Shared schemas for serverless tools
  const endpointIdSchema = z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid endpoint ID format');

  const jobIdSchema = z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid job ID format');

  const inputSchema = z
    .record(z.unknown())
    .describe(
      'Input payload for the worker handler. The expected fields depend on the deployed model or worker.'
    );

  const webhookSchema = z
    .string()
    .url()
    .optional()
    .describe(
      'Webhook URL to receive job completion notifications instead of polling'
    );

  const policySchema = z
    .object({
      executionTimeout: z
        .number()
        .optional()
        .describe('Maximum execution time in milliseconds'),
      lowPriority: z
        .boolean()
        .optional()
        .describe('Submit as a low-priority job'),
      ttl: z
        .number()
        .optional()
        .describe('Time-to-live for the job result in milliseconds'),
    })
    .optional()
    .describe('Execution policy options');

  const s3ConfigSchema = z
    .object({
      accessId: z.string().describe('S3 access key ID'),
      accessSecret: z.string().describe('S3 secret access key'),
      bucketName: z.string().describe('S3 bucket name'),
      endpointUrl: z.string().describe('S3 endpoint URL'),
    })
    .optional()
    .describe('S3-compatible storage config for large outputs');

  // Run Endpoint (Async)
  server.tool(
    'run-endpoint',
    'Submit an asynchronous job to a Serverless endpoint. Returns a job ID immediately — use get-job-status to poll for results. Async results are available for 30 minutes after completion.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint to run'
      ),
      input: inputSchema,
      webhook: webhookSchema,
      policy: policySchema,
      s3Config: s3ConfigSchema,
    },
    { title: 'Run endpoint (async)', ...WRITE },
    async (params) => {
      const { endpointId, ...body } = params;
      const result = await serverlessRequest(
        endpointId,
        '/run',
        'POST',
        body as Record<string, unknown>
      );

      return jsonReply(result);
    }
  );

  // Run Endpoint Sync
  server.tool(
    'runsync-endpoint',
    'Submit a synchronous job to a Serverless endpoint and wait for the result. Best for fast tasks: if the job outlives the wait, the response returns a job ID to poll with get-job-status. Max payload 20 MB; results expire after 1 minute. The wait parameter extends the server-side wait to 5 minutes (300000 ms), but the hosted server caps it at 45 seconds. For longer jobs use run-endpoint + get-job-status, or POST api.runpod.ai/v2/{endpointId}/runsync?wait=300000 directly with a Bearer API key.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint to run synchronously'
      ),
      input: inputSchema,
      wait: z
        .number()
        .min(1000)
        .max(300000)
        .optional()
        .describe(
          'How long in milliseconds the server should wait for a result before returning a job ID to poll (1000–300000). Defaults to 90000 (90 seconds). On the hosted (HTTP) server the effective wait is capped at 45000.'
        ),
      webhook: webhookSchema,
      policy: policySchema,
      s3Config: s3ConfigSchema,
    },
    { title: 'Run endpoint (sync)', ...WRITE },
    async (params) => {
      const { endpointId, wait, ...body } = params;
      // On http the wait is ALWAYS sent, clamped: both the upstream default
      // (90s) and the param ceiling (300s) outlive the platform deadline, so an
      // omitted wait is just as fatal as a long one. When the clamped wait
      // expires the response carries the job ID + IN_PROGRESS — the documented
      // get-job-status path. stdio passes the caller's wait through untouched.
      const effectiveWait =
        rt.transport === 'http'
          ? Math.min(
              wait ?? RUNSYNC_UPSTREAM_DEFAULT_WAIT_MS,
              HTTP_LONG_POLL_BUDGET_MS
            )
          : wait;
      const path = `/runsync${effectiveWait ? `?wait=${effectiveWait}` : ''}`;
      const result = await serverlessRequest(
        endpointId,
        path,
        'POST',
        body as Record<string, unknown>
      );

      return jsonReply(result);
    }
  );

  // Get Job Status
  server.tool(
    'get-job-status',
    'Check the status of an asynchronous Serverless job. Returns the current status and output when complete. Job statuses: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, CANCELLED, TIMED_OUT. IMPORTANT: a job stuck IN_QUEUE does not necessarily mean a capacity shortage — a worker may have spun up and crash-looped (the platform marks it UNHEALTHY while the job stays queued). When the job is IN_QUEUE this tool attaches a workerHealth summary and a hint; to dig deeper, call list-endpoint-workers (look for UNHEALTHY) and stream-worker-logs.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint the job belongs to'
      ),
      jobId: jobIdSchema.describe('ID of the job to check'),
    },
    { title: 'Get job status', ...READ_ONLY },
    async (params) => {
      const result = await serverlessRequest(
        params.endpointId,
        `/status/${params.jobId}`
      );

      if (
        result &&
        typeof result === 'object' &&
        (result as { status?: string }).status === 'IN_QUEUE'
      ) {
        const diagnosis = await diagnoseQueuedJob(params.endpointId);
        if (diagnosis) {
          return jsonReply({
            ...(result as Record<string, unknown>),
            workerHealth: diagnosis.workerHealth,
            ...(diagnosis.hint ? { hint: diagnosis.hint } : {}),
          });
        }
      }

      return jsonReply(result);
    }
  );

  // Stream Job Results
  server.tool(
    'stream-job',
    'Retrieve streaming output from a Serverless job. The worker must support streaming output. Polls /stream/{jobId} and collects chunks until the status is COMPLETED, FAILED, CANCELLED, or TIMED_OUT, for up to 5 minutes (45 seconds on the hosted server). If the budget expires first, returns the chunks collected so far with pollingTimedOut: true — call stream-job again to resume where it left off, or get-job-status to check without streaming. For an unbudgeted stream, GET api.runpod.ai/v2/{endpointId}/stream/{jobId} directly with a Bearer API key.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint the job belongs to'
      ),
      jobId: jobIdSchema.describe('ID of the job to stream results from'),
    },
    { title: 'Stream job', ...READ_ONLY },
    async (params) => {
      const TERMINAL_STATUSES = new Set([
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'TIMED_OUT',
      ]);
      const MAX_POLL_TIME_MS =
        rt.transport === 'http' ? HTTP_LONG_POLL_BUDGET_MS : 5 * 60 * 1000;
      const POLL_INTERVAL_MS = 1000;
      const MAX_CONSECUTIVE_ERRORS = 5;
      const allChunks: unknown[] = [];
      let finalResult: Record<string, unknown> = {};
      let consecutiveErrors = 0;
      let lastError: string | undefined;
      const startTime = Date.now();
      // stdio keeps the server's default hold: fewer requests, no deadline to race.
      const streamQuery =
        rt.transport === 'http' ? `?wait=${HTTP_STREAM_POLL_WAIT_MS}` : '';
      const streamPath = `/stream/${params.jobId}${streamQuery}`;

      while (true) {
        try {
          const result = (await serverlessRequest(
            params.endpointId,
            streamPath
          )) as Record<string, unknown>;

          consecutiveErrors = 0;

          if (Array.isArray(result.stream)) {
            allChunks.push(...result.stream);
          }

          finalResult = result;

          if (TERMINAL_STATUSES.has(result.status as string)) {
            break;
          }
        } catch (error) {
          consecutiveErrors++;
          lastError = error instanceof Error ? error.message : String(error);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            finalResult.error = `Polling aborted after ${MAX_CONSECUTIVE_ERRORS} consecutive errors: ${lastError}`;
            break;
          }
        }

        if (Date.now() - startTime > MAX_POLL_TIME_MS) {
          finalResult.pollingTimedOut = true;
          // /stream drains what it hands out, so calling again resumes where
          // this run stopped rather than replaying from the start.
          finalResult.note = `Polling stopped after ${formatBudget(MAX_POLL_TIME_MS)} with the job possibly still running. Call stream-job again to continue collecting output, get-job-status to check the job without streaming, or stream without a budget by calling the runtime API directly (GET https://api.runpod.ai/v2/{endpointId}/stream/{jobId} with a Bearer API key).`;
          // Surface the most recent error (if any) instead of discarding it —
          // the last poll may have been failing (e.g. job expired) even though
          // earlier polls succeeded.
          if (lastError) finalResult.lastError = lastError;
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      return jsonReply({ ...finalResult, stream: allChunks });
    }
  );

  // Cancel Job
  server.tool(
    'cancel-job',
    'Cancel a Serverless job that is queued or in progress.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint the job belongs to'
      ),
      jobId: jobIdSchema.describe('ID of the job to cancel'),
    },
    { title: 'Cancel job', ...WRITE, idempotentHint: true },
    async (params) => {
      const result = await serverlessRequest(
        params.endpointId,
        `/cancel/${params.jobId}`,
        'POST'
      );

      return jsonReply(result);
    }
  );

  // Retry Job
  server.tool(
    'retry-job',
    'Retry a failed or timed-out Serverless job. Only works for jobs with FAILED or TIMED_OUT status. The previous output is removed and the job is requeued.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint the job belongs to'
      ),
      jobId: jobIdSchema.describe('ID of the job to retry'),
    },
    { title: 'Retry job', ...WRITE },
    async (params) => {
      const result = await serverlessRequest(
        params.endpointId,
        `/retry/${params.jobId}`,
        'POST'
      );

      return jsonReply(result);
    }
  );

  // Endpoint Health
  server.tool(
    'endpoint-health',
    'Get the health and operational status of a Serverless endpoint, including worker counts and job statistics. Use this when jobs are stuck IN_QUEUE: unhealthy workers mean a crash-looping container (a worker failure — inspect with stream-worker-logs), while zero workers means the endpoint is waiting for GPU capacity.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint to check health for'
      ),
    },
    { title: 'Endpoint health', ...READ_ONLY },
    async (params) => {
      const result = await serverlessRequest(params.endpointId, '/health');

      return jsonReply(result);
    }
  );

  // Purge Endpoint Queue
  server.tool(
    'purge-endpoint-queue',
    'Remove all pending jobs from a Serverless endpoint queue. Only affects queued jobs — in-progress jobs continue running. Use this for error recovery or clearing outdated requests.',
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint to purge the queue for'
      ),
    },
    { title: 'Purge endpoint queue', ...WRITE, idempotentHint: true },
    async (params) => {
      const result = await serverlessRequest(
        params.endpointId,
        '/purge-queue',
        'POST'
      );

      return jsonReply(result);
    }
  );
}
