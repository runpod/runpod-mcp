import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRunpodClient } from '@runpod/typescript-api-sdk';
import { dispatchGeneratedTool } from '#src/specgen/dispatch';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { createSpecgenServer } from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';

interface Captured {
  url: URL;
  body: unknown;
}

function recordingSdk(captured: Captured[]) {
  return createRunpodClient({
    apiKey: 'test',
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const text = await request.text();
      captured.push({
        url: new URL(request.url),
        body: text ? JSON.parse(text) : undefined,
      });
      return new Response('{}', {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

function tool(name: string) {
  const found = generatedTools.find((candidate) => candidate.name === name);
  assert.ok(found, `missing tool ${name}`);
  return found;
}

test('an empty cudaVersions next to minCudaVersion is treated as omitted', async () => {
  const captured: Captured[] = [];
  await dispatchGeneratedTool(recordingSdk(captured), tool('get-gpu-type'), {
    id: 'NVIDIA GeForce RTX 4090',
    include: ['AVAILABILITY'],
    product: ['POD'],
    cudaVersions: [],
    minCudaVersion: '12.8',
    countryCodes: [],
  });
  assert.equal(captured.length, 1);
  const query = captured[0].url.searchParams;
  assert.equal(query.get('minCudaVersion'), '12.8');
  assert.equal(query.has('cudaVersions'), false);
  assert.equal(query.has('countryCodes'), false);
  assert.equal(query.get('include'), 'AVAILABILITY');
});

test('a null lastN next to an explicit billing range is treated as omitted', async () => {
  const captured: Captured[] = [];
  await dispatchGeneratedTool(recordingSdk(captured), tool('list-billing'), {
    bucketSize: 'day',
    startTime: '2026-10-01T00:00:00Z',
    endTime: '2026-10-02T00:00:00Z',
    lastN: null,
  });
  const query = captured[0].url.searchParams;
  assert.equal(query.has('lastN'), false);
  assert.equal(query.get('startTime'), '2026-10-01T00:00:00Z');
});

test('an empty first-page cursor is treated as omitted', async () => {
  const captured: Captured[] = [];
  await dispatchGeneratedTool(recordingSdk(captured), tool('list-pods'), {
    cursor: '',
    limit: 5,
  });
  const query = captured[0].url.searchParams;
  assert.equal(query.has('cursor'), false);
  assert.equal(query.get('limit'), '5');
});

test('an empty required path argument is still sent, not dropped', async () => {
  const captured: Captured[] = [];
  const result = await dispatchGeneratedTool(
    recordingSdk(captured),
    tool('get-pod'),
    {
      id: '',
    }
  );
  // The path gate only rejects undefined/null; an empty string reaches
  // upstream, which answers it. What matters is that the query rule above
  // never reaches path params.
  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
});

test('stringified numbers and booleans in a body are converted where the schema wants them', async () => {
  const captured: Captured[] = [];
  await dispatchGeneratedTool(recordingSdk(captured), tool('update-endpoint'), {
    id: 'ep',
    body: {
      disk: '60',
      flashboot: 'FLASHBOOT',
      scaling: { type: 'QUEUE_DELAY', queueDelay: '1' },
      workers: { idleTimeout: '300', max: '3', min: '1' },
      env: { MAX_MODEL_LEN: '32768', DEBUG: 'true' },
    },
  });
  assert.deepEqual(captured[0].body, {
    disk: 60,
    flashboot: 'FLASHBOOT',
    scaling: { type: 'QUEUE_DELAY', queueDelay: 1 },
    workers: { idleTimeout: 300, max: 3, min: 1 },
    // env values are strings in the schema and stay strings.
    env: { MAX_MODEL_LEN: '32768', DEBUG: 'true' },
  });
});

test('string fields that look numeric stay strings; non-numeric strings are forwarded untouched', async () => {
  const captured: Captured[] = [];
  await dispatchGeneratedTool(
    recordingSdk(captured),
    tool('create-network-volume'),
    {
      body: { name: '123', size: '150', dataCenter: 'CA-MTL-1' },
    }
  );
  assert.deepEqual(captured[0].body, {
    name: '123',
    size: 150,
    dataCenter: 'CA-MTL-1',
  });

  const second: Captured[] = [];
  await dispatchGeneratedTool(
    recordingSdk(second),
    tool('create-network-volume'),
    {
      body: { name: 'x', size: 'big', dataCenter: 'CA-MTL-1' },
    }
  );
  assert.equal((second[0].body as { size: unknown }).size, 'big');
});

test('a stringified body with stringified numbers is parsed and converted', async () => {
  const captured: Captured[] = [];
  await dispatchGeneratedTool(
    recordingSdk(captured),
    tool('create-network-volume'),
    {
      body: JSON.stringify({ name: 'x', size: '20', dataCenter: 'EU-RO-1' }),
    }
  );
  assert.deepEqual(captured[0].body, {
    name: 'x',
    size: 20,
    dataCenter: 'EU-RO-1',
  });
});

async function hintFor(status: number, body: unknown): Promise<string> {
  const ctx = createToolContext({ apiKey: 'fake' });
  const sdk = createRunpodClient({
    apiKey: 'fake',
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  });
  // createToolContext exposes sdk as a lazy getter; swap in the stub.
  Object.defineProperty(ctx, 'sdk', { value: sdk });
  const server = createSpecgenServer(ctx, 'test');
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({ name: 'list-pods', arguments: {} });
    assert.equal(result.isError, true);
    return JSON.parse((result.content as Array<{ text: string }>)[0].text).hint;
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

test('a 400 hint names the upstream cause instead of calling it a shape mismatch', async () => {
  const capacity = await hintFor(400, {
    detail:
      'There are no longer any instances available with the requested specifications. Please refresh and try again.',
    status: 400,
    title: 'Bad Request',
  });
  assert.match(capacity, /^Capacity, not input/);
  assert.doesNotMatch(capacity, /Input shape mismatch/);

  const startCapacity = await hintFor(400, {
    detail:
      'There are not enough free GPUs on the host machine to start this pod.',
  });
  assert.match(startCapacity, /^Capacity, not input/);

  const balance = await hintFor(400, {
    detail:
      'You must have at least $5 in your account to create a network volume',
  });
  assert.match(balance, /^Account balance, not input/);

  const conflict = await hintFor(400, {
    detail:
      'cudaVersions and minCudaVersion are mutually exclusive; supply one or the other',
  });
  assert.match(conflict, /^Two arguments conflict/);

  const unfunded = await hintFor(400, { detail: 'Unauthorized', status: 400 });
  assert.match(unfunded, /no balance/);

  // "load balancer" must not read as an account-balance problem.
  const loadBalancer = await hintFor(400, {
    detail: '/run is not allowed for LB API, use load balancer endpoint',
  });
  assert.match(loadBalancer, /Input shape mismatch/);
});

test('real validation failures keep the shape hint', async () => {
  const fieldErrors = await hintFor(422, {
    title: 'Unprocessable Entity',
    detail: 'Request validation failed.',
    errors: ['$.disk: got string, want integer'],
  });
  assert.match(fieldErrors, /Input shape mismatch/);

  const fieldErrors400 = await hintFor(400, {
    detail: 'balance something',
    errors: ['$.size: got string, want integer'],
  });
  assert.match(fieldErrors400, /Input shape mismatch/);
});

// The curated tools read their arguments in hand-written handlers, so the
// query-param rule above never reached them. A strict-schema client sends
// `wait: null` on every get-job-status call, and every optional GPU field on
// set-endpoint-gpus as null.
async function callCurated(
  ctx: ReturnType<typeof createToolContext>,
  name: string,
  args: Record<string, unknown>
) {
  const server = createSpecgenServer(ctx, 'test');
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      payload: JSON.parse((result.content as Array<{ text: string }>)[0].text),
    };
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}

test('a null wait on get-job-status and runsync-endpoint is treated as omitted', async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const ctx = createToolContext({ apiKey: 'fake' });
  Object.defineProperty(ctx, 'runtime', {
    value: async (
      _endpointId: string,
      path: string,
      opts: { body?: unknown } = {}
    ) => {
      calls.push({ path, body: opts.body });
      return { id: 'job', status: 'COMPLETED', output: 'ok' };
    },
  });

  const status = await callCurated(ctx, 'get-job-status', {
    endpointId: 'ep',
    jobId: 'job',
    wait: null,
  });
  assert.equal(status.isError, false, JSON.stringify(status.payload));
  assert.equal(status.payload.status, 'COMPLETED');

  const runsync = await callCurated(ctx, 'runsync-endpoint', {
    endpointId: 'ep',
    input: { prompt: 'hi' },
    wait: null,
    webhook: null,
    policy: null,
    s3Config: null,
  });
  assert.equal(runsync.isError, false, JSON.stringify(runsync.payload));
  assert.deepEqual(calls.at(-1), {
    path: '/runsync',
    body: { input: { prompt: 'hi' } },
  });
});

test('run-endpoint does not forward null optional fields in the job body', async () => {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const ctx = createToolContext({ apiKey: 'fake' });
  Object.defineProperty(ctx, 'runtime', {
    value: async (
      _endpointId: string,
      path: string,
      opts: { body?: unknown } = {}
    ) => {
      calls.push({ path, body: opts.body });
      return { id: 'job', status: 'IN_QUEUE' };
    },
  });
  const result = await callCurated(ctx, 'run-endpoint', {
    endpointId: 'ep',
    input: { prompt: 'hi' },
    webhook: null,
    policy: null,
    s3Config: null,
  });
  assert.equal(result.isError, false, JSON.stringify(result.payload));
  assert.deepEqual(calls, [
    { path: '/run', body: { input: { prompt: 'hi' } } },
  ]);
});

test('set-endpoint-gpus treats null optional fields as omitted', async () => {
  const captured: Captured[] = [];
  const endpoint = {
    id: 'ep',
    name: 'n',
    gpu: { pools: ['ADA_24'], count: 1 },
  };
  const ctx = createToolContext({ apiKey: 'fake' });
  Object.defineProperty(ctx, 'sdk', {
    value: createRunpodClient({
      apiKey: 'fake',
      fetch: async (input: Request | string | URL, init?: RequestInit) => {
        const request =
          input instanceof Request ? input : new Request(input, init);
        const text = await request.text();
        const body = text ? JSON.parse(text) : undefined;
        captured.push({ url: new URL(request.url), body });
        return Response.json(
          body
            ? { ...endpoint, gpu: { ...endpoint.gpu, ...body.gpu } }
            : endpoint
        );
      },
    }),
  });
  const result = await callCurated(ctx, 'set-endpoint-gpus', {
    endpointId: 'ep',
    gpuIds: null,
    pools: ['AMPERE_80'],
    excludeGpuTypeIds: null,
    gpuCount: null,
    minCudaVersion: null,
    allowedCudaVersions: null,
  });
  assert.equal(result.isError, false, JSON.stringify(result.payload));
  assert.deepEqual(captured.at(-1)?.body, {
    gpu: { pools: ['AMPERE_80'], excludedTypes: [] },
  });
});

test('a null required curated argument is still reported missing', async () => {
  const ctx = createToolContext({ apiKey: 'fake' });
  Object.defineProperty(ctx, 'runtime', {
    value: async () => assert.fail('a null jobId reached the runtime API'),
  });
  const result = await callCurated(ctx, 'get-job-status', {
    endpointId: 'ep',
    jobId: null,
    wait: null,
  });
  assert.equal(result.isError, true);
  assert.match(result.payload.error, /Missing required argument: jobId/);
});
