// The trimmed list overlays: drop fat fields, page on the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTemplates } from '#src/specgen/tools/list-templates';
import { listEndpoints } from '#src/specgen/tools/list-endpoints';
import type { ToolContext } from '#src/specgen/context';

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
  const { endpoints } = result.payload as {
    endpoints: Array<Record<string, unknown>>;
  };
  assert.equal(endpoints.length, 2);
  assert.equal(endpoints[0].id, 'ep_0');
  assert.equal(endpoints[0].image, 'runpod/worker:1');
  assert.ok(!('env' in endpoints[0]), 'env must be dropped');
  assert.ok(!('requestUrls' in endpoints[0]), 'requestUrls must be dropped');
  assert.ok(!JSON.stringify(result.payload).includes('do-not-echo'));
});

test('list overlays send the shared page size and hand back an opaque cursor', async () => {
  for (const [tool, path, key] of [
    [listEndpoints, '/v2/serverless', 'endpoints'],
    [listTemplates, '/v2/templates', 'templates'],
  ] as const) {
    const calls: Call[] = [];
    const first = await tool.handler(
      fakeCtx(20, { nextCursor: 'c2VydmVy', hasNextPage: true }, calls),
      {}
    );
    assert.deepEqual(calls[0], { path, query: { limit: 20 } });
    const page = first.payload as Record<string, unknown> & {
      pagination: { nextCursor: string; hasNextPage: boolean };
    };
    assert.equal((page[key] as unknown[]).length, 20);
    assert.equal(page.pagination.hasNextPage, true);

    // The cursor is ours (opaque); it carries the API's cursor to the API.
    await tool.handler(fakeCtx(3, undefined, calls), {
      cursor: page.pagination.nextCursor,
    });
    assert.deepEqual(calls[1], {
      path,
      query: { limit: 20, cursor: 'c2VydmVy' },
    });
  }
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
