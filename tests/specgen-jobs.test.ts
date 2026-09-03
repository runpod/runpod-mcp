// Hosted deadline invariants for the job-wait loops, driven through the
// exported seams (no server, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  pollJobStatus,
  streamPollTimeoutMs,
  STATUS_WAIT_MAX_MS,
  STREAM_BUDGET_MS,
  HTTP_LONG_POLL_BUDGET_MS,
  HOSTED,
  getJobStatus,
} from '../src/specgen/tools/jobs.js';

test('hosted budgets stay under the 60s gateway deadline', () => {
  // The suite does not run on Vercel, so HOSTED is false here — assert the
  // constants directly: the hosted clamp value leaves >= 10s of slack for
  // serialization, and the budgets derive from the flag.
  assert.equal(HTTP_LONG_POLL_BUDGET_MS, 45_000);
  assert.ok(HTTP_LONG_POLL_BUDGET_MS <= 50_000);
  if (HOSTED) {
    assert.equal(STREAM_BUDGET_MS, HTTP_LONG_POLL_BUDGET_MS);
    assert.equal(STATUS_WAIT_MAX_MS, HTTP_LONG_POLL_BUDGET_MS);
  } else {
    assert.equal(STREAM_BUDGET_MS, 300_000);
    assert.equal(STATUS_WAIT_MAX_MS, 300_000);
  }
});

test('pollJobStatus bounds each /status call by the remaining budget', async () => {
  const timeouts: number[] = [];
  const result = await pollJobStatus({
    fetchStatus: async (timeoutMs) => {
      timeouts.push(timeoutMs);
      return { status: timeouts.length >= 3 ? 'COMPLETED' : 'IN_QUEUE' };
    },
    budgetMs: 10_000,
    pollIntervalMs: 20,
  });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(timeouts.length, 3);
  // Each poll is bounded by what remains of the budget (never above it), and
  // never below the 2s floor that keeps the last poll answerable.
  for (const t of timeouts) {
    assert.ok(t <= 10_000, `poll timeout ${t} exceeds the budget`);
    assert.ok(t >= 2_000, `poll timeout ${t} below the floor`);
  }
  assert.ok(timeouts[2] <= timeouts[0], 'remaining budget must shrink');
});

test('pollJobStatus floors a nearly-spent budget instead of a sub-second poll', async () => {
  const timeouts: number[] = [];
  await pollJobStatus({
    fetchStatus: async (timeoutMs) => {
      timeouts.push(timeoutMs);
      return { status: 'IN_QUEUE' };
    },
    budgetMs: 100,
    pollIntervalMs: 10,
  });
  for (const t of timeouts) assert.equal(t, 2_000);
});

test('pollJobStatus returns terminal status immediately', async () => {
  let calls = 0;
  const result = await pollJobStatus({
    fetchStatus: async () => {
      calls++;
      return { status: 'COMPLETED', output: { ok: 1 } };
    },
    budgetMs: 60_000,
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'COMPLETED');
});

test('pollJobStatus wall clock stays near the budget when fetch hangs briefly', async () => {
  const start = Date.now();
  await pollJobStatus({
    fetchStatus: (timeoutMs) =>
      new Promise((resolve) =>
        setTimeout(
          () => resolve({ status: 'IN_QUEUE' }),
          Math.min(timeoutMs, 80)
        )
      ),
    budgetMs: 200,
    pollIntervalMs: 10,
  });
  const elapsed = Date.now() - start;
  // budget + one in-flight poll + interval, with generous CI slack
  assert.ok(elapsed < 1_500, `took ${elapsed}ms for a 200ms budget`);
});

test('streamPollTimeoutMs never exceeds remaining budget (above its floor)', () => {
  assert.equal(streamPollTimeoutMs(3_000, 10_000), 3_000);
  assert.equal(streamPollTimeoutMs(500, 10_000), 2_000); // floor
  assert.equal(streamPollTimeoutMs(60_000, 10_000), 15_000); // hold + slack
});

test('the hosted budget clears vercel.json maxDuration with slack', () => {
  // The cross-file invariant (re-homed from the deleted tests/http.test.ts):
  // vercel.json's maxDuration is the platform clock, and the hosted wait
  // ceiling must clear it with room for the credential pre-flight (4s), cold
  // start, and serializing the reply. Moving either side without the other
  // fails here, not in production.
  const maxDuration = (
    JSON.parse(
      readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
    ) as { functions?: Record<string, { maxDuration?: number }> }
  ).functions?.['api/index.ts']?.maxDuration;
  assert.ok(
    typeof maxDuration === 'number',
    'vercel.json no longer declares a maxDuration for api/index.ts'
  );
  const PRE_FLIGHT_MS = 4_000;
  const SERIALIZE_AND_COLD_START_MS = 5_000;
  assert.ok(
    HTTP_LONG_POLL_BUDGET_MS + PRE_FLIGHT_MS + SERIALIZE_AND_COLD_START_MS <=
      maxDuration * 1000,
    `HTTP_LONG_POLL_BUDGET_MS (${HTTP_LONG_POLL_BUDGET_MS}) leaves no room under maxDuration (${maxDuration}s)`
  );
});

// Regression: the crash-loop diagnosis must survive a spent wait budget.
// v1 (runpod/runpod-mcp) had no `wait` on get-job-status, so it attached the
// worker summary on EVERY IN_QUEUE. v2 added server-side blocking and, to
// protect the hosted deadline, skipped the diagnosis whenever pollingTimedOut
// was set — which is exactly what a `wait` that rides out a cold start
// produces, so the hint became unreachable on the path the tool recommends.
// A TTL cache (ported from v1) makes the extra round trip affordable instead.
test('get-job-status attaches workerHealth even when the wait budget is spent', async () => {
  let workerCalls = 0;
  const ctx = {
    runtime: async () => ({ status: 'IN_QUEUE' }),
    sdk: {
      GET: async () => {
        workerCalls++;
        return {
          data: {
            summary: { total: 3, unhealthy: 1, initializing: 1, running: 1 },
            workers: [{ id: 'w-bad', status: 'UNHEALTHY' }],
          },
        };
      },
    },
  } as unknown as Parameters<typeof getJobStatus.handler>[0];

  const result = await getJobStatus.handler(ctx, {
    endpointId: 'ep-diag-1',
    jobId: 'job-1',
    wait: 1000,
  });
  const payload = result.payload as Record<string, unknown>;

  assert.equal(payload.pollingTimedOut, true, 'budget should be spent');
  assert.deepEqual(payload.workerHealth, {
    total: 3,
    unhealthy: 1,
    initializing: 1,
    running: 1,
  });
  assert.match(String(payload.hint), /UNHEALTHY/);
  assert.match(String(payload.hint), /w-bad/);

  // Second call on the same endpoint is served from the TTL cache — the
  // diagnosis costs one upstream round trip per endpoint, not one per poll.
  await getJobStatus.handler(ctx, {
    endpointId: 'ep-diag-1',
    jobId: 'job-1',
    wait: 1000,
  });
  assert.equal(workerCalls, 1, 'diagnosis should be cached per endpoint');
});
