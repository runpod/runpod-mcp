import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCapacity } from '#src/specgen/tools/capacity';
import { createToolContext } from '#src/specgen/context';

// GPU A is offered on both clouds. GPU B is offered on Secure Cloud only, yet
// the catalog still carries a Community price and lowestPrice returns it.
const gpuTypes = [
  {
    id: 'TEST GPU A',
    displayName: 'GPU A',
    memoryInGb: 24,
    secureCloud: true,
    communityCloud: true,
    securePrice: 0.89,
    communityPrice: 0.34,
    lowestPrice: {
      stockStatus: 'Low',
      uninterruptablePrice: 0.34,
      gpuTypeCudaVersions: [{ cudaVersion: '13.2', availability: 'AVAILABLE' }],
    },
  },
  {
    id: 'TEST GPU B',
    displayName: 'GPU B',
    memoryInGb: 48,
    secureCloud: true,
    communityCloud: false,
    securePrice: 0.59,
    communityPrice: 0.35,
    lowestPrice: {
      stockStatus: 'Low',
      uninterruptablePrice: 0.35,
      gpuTypeCudaVersions: [{ cudaVersion: '13.2', availability: 'AVAILABLE' }],
    },
  },
];

function mockGraphql(t: { mock: { method: typeof test.mock.method } }) {
  const queries: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      queries.push(((await request.json()) as { query: string }).query);
      return Response.json({ data: { gpuTypes } });
    }
  );
  return queries;
}

function rowsOf(payload: unknown): Array<Record<string, unknown>> {
  return (payload as { gpus: Array<Record<string, unknown>> }).gpus;
}

test('matrix mode returns each cloud price next to the cheapest one', async (t) => {
  const queries = mockGraphql(t);
  const result = await getCapacity.handler(
    createToolContext({ apiKey: 'test-key', sdkRetry: false }),
    {}
  );
  assert.equal(result.ok, true);
  assert.match(queries[0], /securePrice\s+communityPrice/);
  const byId = Object.fromEntries(
    rowsOf(result.payload).map((row) => [row.id, row])
  );
  assert.equal(byId['TEST GPU A'].pricePerHr, 0.34);
  assert.equal(byId['TEST GPU A'].securePricePerGpuHr, 0.89);
  assert.equal(byId['TEST GPU A'].communityPricePerGpuHr, 0.34);
  assert.equal(byId['TEST GPU B'].pricePerHr, 0.35);
  assert.equal(byId['TEST GPU B'].securePricePerGpuHr, 0.59);
  assert.equal(byId['TEST GPU B'].communityPricePerGpuHr, null);
});

test('probe mode returns each cloud price once per GPU', async (t) => {
  const queries = mockGraphql(t);
  const result = await getCapacity.handler(
    createToolContext({ apiKey: 'test-key', sdkRetry: false }),
    { cudaVersions: ['13.2'], gpuTypeIds: ['GPU B'] }
  );
  assert.equal(result.ok, true);
  assert.match(queries[0], /securePrice\s+communityPrice/);
  const [row] = rowsOf(result.payload);
  assert.equal(row.securePricePerGpuHr, 0.59);
  assert.equal(row.communityPricePerGpuHr, null);
});

test('probe mode pages its GPUs like every other list', async (t) => {
  mockGraphql(t);
  const ctx = createToolContext({ apiKey: 'test-key', sdkRetry: false });
  type Page = {
    probedCudaVersions: string[];
    gpus: Array<{ id: string }>;
    pagination: {
      returned: number;
      hasNextPage: boolean;
      nextCursor: string | null;
    };
  };
  const args = { cudaVersions: ['13.2'], limit: 1 };
  const first = (await getCapacity.handler(ctx, args)).payload as Page;
  assert.deepEqual(first.probedCudaVersions, ['13.2']);
  assert.equal(first.gpus.length, 1);
  assert.equal(first.pagination.returned, 1);
  assert.equal(first.pagination.hasNextPage, true);
  const second = (
    await getCapacity.handler(ctx, {
      ...args,
      cursor: first.pagination.nextCursor,
    })
  ).payload as Page;
  assert.equal(second.pagination.hasNextPage, false);
  assert.deepEqual(
    [...first.gpus, ...second.gpus].map((gpu) => gpu.id).sort(),
    ['TEST GPU A', 'TEST GPU B']
  );
});

test('probe mode also returns the whole catalog by default', async (t) => {
  // 25 GPUs: more than the shared default of 20, so a probe-mode call that
  // lost its own default (100) would come back short.
  const many = Array.from({ length: 25 }, (_, i) => ({
    ...gpuTypes[0],
    id: `TEST GPU ${i}`,
    displayName: `GPU ${i}`,
  }));
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ data: { gpuTypes: many } })
  );
  const ctx = createToolContext({ apiKey: 'test-key', sdkRetry: false });
  const page = (await getCapacity.handler(ctx, { cudaVersions: ['13.2'] }))
    .payload as { gpus: unknown[]; pagination: { hasNextPage: boolean } };
  assert.equal(page.gpus.length, 25);
  assert.equal(page.pagination.hasNextPage, false);
});
