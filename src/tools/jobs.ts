import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { READ_ONLY, WRITE, type ToolRuntime } from './runtime.js';

// ============== SERVERLESS RUNTIME TOOLS ==============
// Job submission and lifecycle against the Serverless runtime API
// (api.runpod.ai/v2/{endpointId}/...). Distinct from endpoint CRUD.

export function registerJobTools(server: McpServer, rt: ToolRuntime): void {
  const { jsonReply, serverlessRequest } = rt;

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
    'Submit a synchronous job to a Serverless endpoint and wait for the result. Best for tasks completing within 90 seconds. If processing exceeds 90 seconds, the response returns a job ID to poll with get-job-status. Max payload: 20 MB. Results expire after 1 minute. Use the wait parameter to extend the server-side wait up to 5 minutes (300000 ms).',
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
          'How long in milliseconds the server should wait for a result before returning a job ID to poll (1000–300000). Defaults to 90000 (90 seconds).'
        ),
      webhook: webhookSchema,
      policy: policySchema,
      s3Config: s3ConfigSchema,
    },
    { title: 'Run endpoint (sync)', ...WRITE },
    async (params) => {
      const { endpointId, wait, ...body } = params;
      const path = wait ? `/runsync?wait=${wait}` : '/runsync';
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
    'Check the status of an asynchronous Serverless job. Returns the current status and output when complete. Job statuses: IN_QUEUE, IN_PROGRESS, COMPLETED, FAILED, CANCELLED, TIMED_OUT.',
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

      return jsonReply(result);
    }
  );

  // Stream Job Results
  server.tool(
    'stream-job',
    'Retrieve all streaming output from a Serverless job by polling until the job reaches a terminal state. The worker must support streaming output. Polls /stream/{jobId} repeatedly and collects every chunk until status is COMPLETED, FAILED, CANCELLED, or TIMED_OUT.',
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
      const MAX_POLL_TIME_MS = 5 * 60 * 1000; // 5 minutes
      const POLL_INTERVAL_MS = 1000;
      const MAX_CONSECUTIVE_ERRORS = 5;
      const allChunks: unknown[] = [];
      let finalResult: Record<string, unknown> = {};
      let consecutiveErrors = 0;
      let lastError: string | undefined;
      const startTime = Date.now();

      while (true) {
        try {
          const result = (await serverlessRequest(
            params.endpointId,
            `/stream/${params.jobId}`
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
          finalResult.note =
            'Polling timed out after 5 minutes. Use get-job-status to check the job later.';
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
    'Get the health and operational status of a Serverless endpoint, including worker counts and job statistics.',
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
