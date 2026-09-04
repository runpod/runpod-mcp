// The trimmed list-endpoints overlay: drops env/requestUrls, paginates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listEndpoints } from '../src/specgen/tools/list-endpoints.js';
import type { ToolContext } from '../src/specgen/context.js';

const endpoint = (id: number) => ({
  id: `ep_${id}`,
  name: `endpoint-${id}`,
  type: 'QUEUE',
  image: 'runpod/worker:1',
  gpu: { pools: ['ADA_24'], count: 1 },
  cpu: null,
  workers: { min: 0, max: 2 },
  scaling: { type: 'QUEUE_DELAY' },
  dataCenterIds: ['EU-RO-1'],
  flashboot: 'OFF',
  createdAt: '2026-01-01T00:00:00Z',
  env: { SECRET: 'do-not-echo' },
  requestUrls: { run: `https://api.runpod.ai/v2/ep_${id}/run` },
});

const fakeCtx = (count: number) =>
  ({
    sdk: {
      GET: async () => ({
        data: {
          endpoints: Array.from({ length: count }, (_, i) => endpoint(i)),
        },
        error: undefined,
        response: { status: 200 },
      }),
    },
  }) as unknown as ToolContext;

test('drops env and requestUrls, keeps identifying fields', async () => {
  const result = await listEndpoints.handler(fakeCtx(2), {});
  assert.equal(result.ok, true);
  const { items } = result.payload as { items: Array<Record<string, unknown>> };
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'ep_0');
  assert.equal(items[0].image, 'runpod/worker:1');
  assert.ok(!('env' in items[0]), 'env must be dropped');
  assert.ok(!('requestUrls' in items[0]), 'requestUrls must be dropped');
  assert.ok(!JSON.stringify(result.payload).includes('do-not-echo'));
});

test('paginates past the default cap and hands back a cursor', async () => {
  const first = await listEndpoints.handler(fakeCtx(61), {});
  const page1 = first.payload as {
    items: unknown[];
    pagination: {
      total: number;
      nextCursor: string | null;
      truncated: boolean;
    };
  };
  assert.equal(page1.items.length, 20);
  assert.equal(page1.pagination.total, 61);
  assert.ok(page1.pagination.truncated && page1.pagination.nextCursor);
  const last = await listEndpoints.handler(fakeCtx(61), {
    cursor: page1.pagination.nextCursor,
    limit: 100,
  });
  const page2 = last.payload as {
    items: unknown[];
    pagination: { nextCursor: string | null };
  };
  assert.equal(page2.items.length, 41);
  assert.equal(page2.pagination.nextCursor, null);
});

test('capList survives limit 0, junk cursors, and out-of-range offsets', async () => {
  const { capList, MAX_LIST_LIMIT } = await import(
    '../src/specgen/pagination.js'
  );
  const items = Array.from({ length: 5 }, (_, i) => i);

  const zero = capList(items, { limit: 0 });
  assert.ok(
    (zero.items as unknown[]).length > 0,
    'limit 0 must not produce a stuck pager'
  );

  const junk = capList(items, { cursor: '!!not-base64!!' });
  assert.equal((junk.items as unknown[]).length, 5);

  const past = capList(items, {
    cursor: Buffer.from('999').toString('base64'),
  });
  assert.equal((past.items as unknown[]).length, 0);
  assert.equal((past.pagination as { nextCursor: unknown }).nextCursor, null);

  const huge = capList(
    Array.from({ length: 500 }, (_, i) => i),
    { limit: 10_000 }
  );
  assert.equal((huge.items as unknown[]).length, MAX_LIST_LIMIT);
});
