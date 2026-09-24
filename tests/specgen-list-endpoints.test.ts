// The trimmed list overlays: drop fat fields, page on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTemplates } from '../src/specgen/tools/list-templates.js';
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

type Call = { path: string; query: Record<string, unknown> | undefined };

const fakeCtx = (
  count: number,
  pagination = { nextCursor: null as string | null, hasNextPage: false },
  calls: Call[] = []
) =>
  ({
    sdk: {
      GET: async (
        path: string,
        init?: { params?: { query?: Record<string, unknown> } }
      ) => {
        calls.push({ path, query: init?.params?.query });
        return {
          data: {
            endpoints: Array.from({ length: count }, (_, i) => endpoint(i)),
            templates: Array.from({ length: count }, (_, i) => ({
              id: `tpl_${i}`,
              name: `template-${i}`,
              image: 'runpod/pytorch:1',
              serverless: false,
              readme: 'long readme',
            })),
            pagination,
          },
          error: undefined,
          response: new Response(null, { status: 200 }),
        };
      },
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

test('list overlays page on the server and return its cursor verbatim', async () => {
  for (const [tool, path, key] of [
    [listEndpoints, '/v2/serverless', 'items'],
    [listTemplates, '/v2/templates', 'templates'],
  ] as const) {
    const calls: Call[] = [];
    const first = await tool.handler(
      fakeCtx(20, { nextCursor: 'c2VydmVy', hasNextPage: true }, calls),
      {}
    );
    assert.deepEqual(calls[0], { path, query: { limit: 20 } });
    const page = first.payload as Record<string, unknown> & {
      pagination: Record<string, unknown>;
    };
    assert.equal((page[key] as unknown[]).length, 20);
    assert.equal(page.pagination.returned, 20);
    assert.equal(page.pagination.hasNextPage, true);
    assert.equal(page.pagination.nextCursor, 'c2VydmVy');
    assert.ok(page.pagination.note);

    const last = await tool.handler(fakeCtx(3, undefined, calls), {
      cursor: 'c2VydmVy',
      limit: 100,
    });
    assert.deepEqual(calls[1], {
      path,
      query: { limit: 100, cursor: 'c2VydmVy' },
    });
    const lastPage = last.payload as { pagination: Record<string, unknown> };
    assert.equal(lastPage.pagination.hasNextPage, false);
    assert.equal(lastPage.pagination.nextCursor, null);
    assert.ok(!('note' in lastPage.pagination));
  }
});

test('server page query caps the limit and drops empty cursors', async () => {
  const { serverPageQuery, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT } = await import(
    '../src/specgen/pagination.js'
  );
  assert.deepEqual(serverPageQuery({ limit: 0, cursor: '' }), {
    limit: DEFAULT_LIST_LIMIT,
  });
  assert.deepEqual(serverPageQuery({ limit: 10_000 }), {
    limit: MAX_LIST_LIMIT,
  });
  assert.deepEqual(serverPageQuery({ limit: 'junk', cursor: 42 }), {
    limit: DEFAULT_LIST_LIMIT,
  });
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

test('list overlays report malformed upstream collections as gateway errors', async () => {
  for (const tool of [listEndpoints, listTemplates]) {
    for (const data of [
      undefined,
      {},
      { endpoints: {}, templates: 'invalid' },
    ]) {
      const ctx = {
        sdk: { GET: async () => ({ data, response: new Response(null) }) },
      } as unknown as ToolContext;
      const result = await tool.handler(ctx, {});
      assert.equal(result.ok, false);
      assert.equal(result.status, 502);
    }
  }
});
