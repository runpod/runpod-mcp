// Hosted deadline invariants for the job-wait loops, driven through the
// exported seams (no server, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pollJobStatus,
  streamPollTimeoutMs,
  STATUS_WAIT_MAX_MS,
  STREAM_BUDGET_MS,
  HTTP_LONG_POLL_BUDGET_MS,
  HOSTED,
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
