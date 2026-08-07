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

// An http deployment is assumed to sit behind a gateway that reaps the request
// mid-flight; Runpod's hosted one does, at 60s (vercel.json maxDuration). Wait
// longer and the gateway kills the call before the tool's own timeout path
// runs: bare 504, collected output discarded. 45s leaves room for the 4s
// credential pre-flight that precedes dispatch (the v2 probe does NOT apply —
// stdio-only, see backend.ts). Exported for the test that checks it against
// vercel.json; stdio has no deadline.
export const HTTP_LONG_POLL_BUDGET_MS = 45_000;
// Exported so the poll-deadline tests measure attempts against the real stdio
// budget rather than a copy of it.
export const STDIO_STREAM_BUDGET_MS = 5 * 60 * 1000;
// Upstream defaults, mirrored not derived — re-check against ai-api
// (pkg/api/runsync.go, pkg/api/stream.go) if the service changes.
const RUNSYNC_UPSTREAM_DEFAULT_WAIT_MS = 90_000;
// What an empty GET /stream holds for when no ?wait= is sent. stdio omits the
// query, so this — not the http value below — is the hold its polls bracket.
// Exported so those tests read the hold instead of restating it.
export const STREAM_UPSTREAM_DEFAULT_WAIT_MS = 10_000;
// Caps how long an empty /stream may hold the poll. Left at the server's 10s
// default, a chunk-sparse job overshoots the 45s budget to ~54s, since the
// budget is only checked between polls. Accepted range 1000–300000. Exported
// for the same reason as its stdio sibling above.
export const HTTP_STREAM_POLL_WAIT_MS = 1000;
// Exported so the budget tests tick the real interval, not a copy of it.
export const STREAM_JOB_POLL_INTERVAL_MS = 1000;
// Consecutive failures that end the poll. Only reachable while each attempt is
// bounded well inside the budget — see streamPollTimeoutMs. Exported so the
// guard asserting the budget fits that many attempts counts the real cap.
export const MAX_CONSECUTIVE_STREAM_ERRORS = 5;
// Shared by stream-job (stop polling) and runsync (nothing was lost to the
// clamp), so the two can't drift on what "finished" means.
const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
]);
// Annotatable: a plain object (spreading an array yields {"0":…}) for a job
// still running, not already carrying the key.
function isUnfinishedJobReply(
  result: unknown
): result is Record<string, unknown> {
  return (
    result !== null &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    !('waitClamped' in result) &&
    !TERMINAL_STATUSES.has((result as { status?: string }).status ?? '')
  );
}

function formatBudget(ms: number): string {
  return ms >= 120_000
    ? `${Math.round(ms / 60_000)} minutes`
    : `${Math.round(ms / 1000)} seconds`;
}

// A client deadline must outlast the wait the server was asked to hold, or we
// abort the reply we are waiting for; this is the round-trip room on top. Used
// by both long-poll callers (runsync's ?wait=, stream-job's per-poll hold).
// Must also fit under the http ceiling, or the clamp lands the deadline back on
// the hold (asserted in tests/http.test.ts).
export const UPSTREAM_HOLD_SLACK_MS = 5_000;
// So the last poll of a nearly-spent budget can still answer. Exported so the
// floor test asserts the real value.
export const MIN_STREAM_POLL_TIMEOUT_MS = 2_000;
// The queued-job diagnosis is enrichment on an answer we already have, and it is
// discarded on any failure. The shared invocation budget stops it from causing a
// 504, but spending 30 of the caller's seconds to decorate a reply that was
// ready is still the wrong trade — the status belongs to the caller, the hint is
// a bonus. Short enough that losing it costs little.
export const QUEUED_DIAGNOSIS_TIMEOUT_MS = 5_000;

// Deadline for ONE /stream poll: the hold it brackets, bounded by what is left
// of the budget, and never below MIN_STREAM_POLL_TIMEOUT_MS. The budget is a
// ceiling here, never the target —
//
//   above the hold  — a poll that aborts before the server's own wait elapses
//                     kills a reply that was on its way, every time.
//   below the budget — a deadline set TO the budget lets one wedged socket
//                     spend the entire run in a single attempt, so
//                     MAX_CONSECUTIVE_STREAM_ERRORS never engages and the
//                     caller gets nothing back from a stall the retry loop was
//                     built to survive.
//
// The floor only bites once the budget is nearly spent, where a 0ms deadline
// would report a server fault for time we had already used. On the hosted
// transport it is not the last word either: clampTimeout then measures the
// result against the remaining invocation budget, whose own floor is
// MIN_REQUEST_TIMEOUT_MS (src/_shared/http.ts).
export function streamPollTimeoutMs(
  remainingMs: number,
  holdMs: number
): number {
  return Math.max(
    Math.min(remainingMs, holdMs + UPSTREAM_HOLD_SLACK_MS),
    MIN_STREAM_POLL_TIMEOUT_MS
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Everything about a stream-job run that depends on the transport, chosen in
// one place. The query and the hold MUST agree — a poll that asks the server
// for one wait while its deadline brackets another either aborts replies in
// flight or waits far past what it should — and bundling the budget with them
// means a wrong transport here cannot slip past the budget tests.
// stdio sends no ?wait= (fewer requests, no platform deadline to race), so its
// hold is the server's own default rather than one we picked.
export function streamPollPlan(hosted: boolean): {
  budgetMs: number;
  holdMs: number;
  query: string;
} {
  return hosted
    ? {
        budgetMs: HTTP_LONG_POLL_BUDGET_MS,
        holdMs: HTTP_STREAM_POLL_WAIT_MS,
        query: `?wait=${HTTP_STREAM_POLL_WAIT_MS}`,
      }
    : {
        budgetMs: STDIO_STREAM_BUDGET_MS,
        holdMs: STREAM_UPSTREAM_DEFAULT_WAIT_MS,
        query: '',
      };
}

// Both unfinished exits (budget spent, error cap) say the same two things: what
// stopped the run, and that /stream drains what it hands out — so calling again
// resumes where this run stopped rather than replaying from the start. Shared so
// an agent that hits the error cap is not left with chunks and no way forward.
const RESUME_ADVICE =
  'Call stream-job again to continue collecting output, get-job-status to check the job without streaming, or stream without a budget by calling the runtime API directly (GET https://api.runpod.ai/v2/{endpointId}/stream/{jobId} with a Bearer API key).';

function budgetExhaustedNote(
  budgetMs: number,
  lastError: string | undefined
): Record<string, unknown> {
  return {
    pollingTimedOut: true,
    note: `Polling stopped after ${formatBudget(
      budgetMs
    )} with the job possibly still running. ${RESUME_ADVICE}`,
    // Surface the trailing error (if any) instead of discarding it — the last
    // polls may have been failing (e.g. job expired) even though earlier ones
    // succeeded. Cleared on success, so this is never a stale error from
    // minutes of healthy streaming ago.
    ...(lastError ? { lastError } : {}),
  };
}

function errorCapNote(lastError: string): Record<string, unknown> {
  return {
    error: `Polling aborted after ${MAX_CONSECUTIVE_STREAM_ERRORS} consecutive errors: ${lastError}`,
    note: `Polling stopped after ${MAX_CONSECUTIVE_STREAM_ERRORS} consecutive errors with the job possibly still running. ${RESUME_ADVICE}`,
  };
}

// Poll until the job reaches a terminal status, the budget runs out, or the API
// fails MAX_CONSECUTIVE_STREAM_ERRORS times in a row. Lifted out of the handler
// so those three exits read in one screen, and so a test can drive the loop
// through `poll` without an MCP server around it.
export async function collectJobStream(deps: {
  poll: (timeoutMs: number) => Promise<Record<string, unknown>>;
  budgetMs: number;
  holdMs: number;
}): Promise<{ result: Record<string, unknown>; chunks: unknown[] }> {
  const { poll, budgetMs, holdMs } = deps;
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const chunks: unknown[] = [];
  // Never mutated in place: `poll` is caller-supplied now that this is
  // exported, and the last reply is not ours to annotate.
  let result: Record<string, unknown> = {};
  let consecutiveErrors = 0;
  let lastError: string | undefined;

  while (true) {
    try {
      const reply = await poll(
        streamPollTimeoutMs(budgetMs - elapsed(), holdMs)
      );
      // A success clears both: only CONSECUTIVE failures end the run, so a
      // flaky endpoint that answers in between keeps streaming — and the error
      // reported at the end is one that was still happening at the end.
      consecutiveErrors = 0;
      lastError = undefined;
      if (Array.isArray(reply.stream)) chunks.push(...reply.stream);
      result = reply;
      if (TERMINAL_STATUSES.has(reply.status as string)) break;
    } catch (error) {
      consecutiveErrors++;
      lastError = error instanceof Error ? error.message : String(error);
      if (consecutiveErrors >= MAX_CONSECUTIVE_STREAM_ERRORS) {
        result = { ...result, ...errorCapNote(lastError) };
        break;
      }
    }

    if (elapsed() > budgetMs) {
      result = { ...result, ...budgetExhaustedNote(budgetMs, lastError) };
      break;
    }

    await sleep(STREAM_JOB_POLL_INTERVAL_MS);
  }

  return { result, chunks };
}

export function registerJobTools(server: McpServer, rt: ToolRuntime): void {
  const { jsonReply, serverlessRequest, backendFor, callRestUrl } = rt;
  // Built per instance so each caller is told only the budget that applies to
  // them; stating both leaves every reader a clause that is false for them.
  const hosted = rt.transport === 'http';
  const streamBudget = formatBudget(
    hosted ? HTTP_LONG_POLL_BUDGET_MS : STDIO_STREAM_BUDGET_MS
  );

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
        `${backend.base}/serverless/${endpointId}/workers`,
        'GET',
        undefined,
        { timeoutMs: QUEUED_DIAGNOSIS_TIMEOUT_MS }
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
    `Submit a synchronous job to a Serverless endpoint and wait for the result. Best for fast tasks: if the job outlives the wait, the response returns a job ID and a non-terminal status (IN_QUEUE or IN_PROGRESS) to poll with get-job-status. Max payload 20 MB; results expire after 1 minute. ${
      hosted
        ? `This server waits up to ${HTTP_LONG_POLL_BUDGET_MS} ms — it runs behind a 60-second gateway deadline, so that is both the default and the ceiling for the wait parameter. For longer jobs use run-endpoint + get-job-status, or POST https://api.runpod.ai/v2/{endpointId}/runsync?wait=300000 directly with a Bearer API key.`
        : 'The wait parameter extends the server-side wait to up to 5 minutes (300000 ms); it defaults to 90000 (90 seconds).'
    }`,
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
          hosted
            ? `How long in milliseconds the server should wait for a result before returning a job ID to poll. Accepted range 1000–300000, but this server clamps anything above ${HTTP_LONG_POLL_BUDGET_MS} down to ${HTTP_LONG_POLL_BUDGET_MS}, which is also the effective default.`
            : 'How long in milliseconds the server should wait for a result before returning a job ID to poll (1000–300000). Defaults to 90000 (90 seconds).'
        ),
      webhook: webhookSchema,
      policy: policySchema,
      s3Config: s3ConfigSchema,
    },
    { title: 'Run endpoint (sync)', ...WRITE },
    async (params) => {
      const { endpointId, wait, ...body } = params;
      // Always sent on http: the upstream default (90s) outlives the deadline
      // too, so an omitted wait is as fatal as a long one.
      const effectiveWait = hosted
        ? Math.min(
            wait ?? RUNSYNC_UPSTREAM_DEFAULT_WAIT_MS,
            HTTP_LONG_POLL_BUDGET_MS
          )
        : wait;
      // undefined, not falsy: `wait: 0` would drop the query and inherit the
      // upstream 90s default. Zod blocks 0 today, but handlers are called
      // directly (catalog.ts guards the same way).
      const waitQuery =
        effectiveWait === undefined ? '' : `?wait=${effectiveWait}`;
      const path = `/runsync${waitQuery}`;
      const result = await serverlessRequest(
        endpointId,
        path,
        'POST',
        body as Record<string, unknown>,
        {
          // From the wait actually sent — on http the clamped 45s, not the
          // 300s the caller may have asked for.
          timeoutMs:
            (effectiveWait ?? RUNSYNC_UPSTREAM_DEFAULT_WAIT_MS) +
            UPSTREAM_HOLD_SLACK_MS,
        }
      );

      // Unmarked, a reply from a job 45s in is identical to one from a job that
      // outlived the 300s asked for — and the reaction to the latter is to
      // cancel it. Only marked when the caller could actually be misled.
      const requestedWait = wait ?? RUNSYNC_UPSTREAM_DEFAULT_WAIT_MS;
      if (
        hosted &&
        requestedWait > HTTP_LONG_POLL_BUDGET_MS &&
        isUnfinishedJobReply(result)
      ) {
        return jsonReply({
          ...result,
          waitClamped: {
            requestedMs: requestedWait,
            effectiveMs: effectiveWait,
            reason: `This server runs behind a 60-second gateway deadline, so a non-terminal status here means the job outlived ${formatBudget(
              HTTP_LONG_POLL_BUDGET_MS
            )}, not the requested wait — poll get-job-status rather than treating it as stuck.`,
          },
        });
      }

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
    `Retrieve streaming output from a Serverless job. The worker must support streaming output. Polls /stream/{jobId} and collects chunks until the status is COMPLETED, FAILED, CANCELLED, or TIMED_OUT, for up to ${streamBudget}${hosted ? ' (this server runs behind a 60-second gateway deadline)' : ''}. If the budget expires first, returns the chunks collected so far with pollingTimedOut: true — call stream-job again to resume where it left off, or get-job-status to check without streaming.${
      hosted
        ? ' To collect with no budget, poll GET https://api.runpod.ai/v2/{endpointId}/stream/{jobId} yourself with a Bearer API key until the status is terminal — each request drains only the chunks buffered so far, so a single request is not the whole output.'
        : ''
    }`,
    {
      endpointId: endpointIdSchema.describe(
        'ID of the Serverless endpoint the job belongs to'
      ),
      jobId: jobIdSchema.describe('ID of the job to stream results from'),
    },
    { title: 'Stream job', ...READ_ONLY },
    async (params) => {
      const plan = streamPollPlan(hosted);
      const streamPath = `/stream/${params.jobId}${plan.query}`;

      const { result, chunks } = await collectJobStream({
        budgetMs: plan.budgetMs,
        holdMs: plan.holdMs,
        poll: (timeoutMs) =>
          serverlessRequest(params.endpointId, streamPath, 'GET', undefined, {
            timeoutMs,
          }) as Promise<Record<string, unknown>>,
      });

      return jsonReply({ ...result, stream: chunks });
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
