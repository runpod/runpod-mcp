import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer } from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';
import { pollJobStatus } from '../src/specgen/tools/jobs.js';
import { HttpError } from '../src/specgen/clients/http-error.js';

const calls = [
  { name: 'list-endpoints', arguments: {} },
  { name: 'list-templates', arguments: {} },
  { name: 'list-hub-repos', arguments: {} },
  { name: 'stream-pod-logs', arguments: { podId: 'pod' } },
  {
    name: 'get-job-status',
    arguments: { endpointId: 'ep', jobId: 'job', wait: 1000 },
  },
  { name: 'stream-job', arguments: { endpointId: 'ep', jobId: 'job' } },
];

test('curated tools preserve upstream failures, re-auth and wait hints through MCP', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [200, 401, 403, 404, 429]) {
      for (const empty of [true, false]) {
        if (status === 200 && !empty) continue;
        let requests = 0;
        globalThis.fetch = async () => {
          requests++;
          return new Response(
            empty ? null : JSON.stringify({ error: 'upstream failure' }),
            {
              status,
              headers: {
                ...(empty
                  ? { 'content-length': '0' }
                  : { 'content-type': 'application/json' }),
                'retry-after': '120',
              },
            }
          );
        };
        let invalidations = 0;
        const server = createSpecgenServer(
          createToolContext({ apiKey: 'fake', sdkRetry: false }),
          'test',
          {
            onUnauthorized: () => {
              invalidations++;
            },
          }
        );
        const client = new Client({ name: 'test', version: '1' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        try {
          await Promise.all([server.connect(st), client.connect(ct)]);
          for (const call of status === 200 ? calls.slice(0, 2) : calls) {
            const before = requests;
            const result = await client.callTool(call);
            assert.equal(
              result.isError,
              true,
              `${call.name} ${status} empty=${empty}`
            );
            assert.equal(
              requests - before,
              1,
              'client errors must not be polled repeatedly'
            );
            const payload = JSON.parse(
              (result.content as Array<{ text: string }>)[0].text
            );
            if (status === 429) assert.match(payload.hint, /120s/);
            if (status === 401) assert.match(payload.hint, /key.*invalid/);
          }
          assert.equal(invalidations, status === 401 ? calls.length : 0);
        } finally {
          await client.close();
          await server.close();
        }
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

test('job polling still recovers from transient upstream failures', async () => {
  for (const status of [408, 503]) {
    let attempts = 0;
    const result = await pollJobStatus({
      fetchStatus: async () => {
        if (++attempts === 1) throw new HttpError('transient', status);
        return { status: 'COMPLETED', output: 'done' };
      },
      budgetMs: 1000,
      pollIntervalMs: 0,
    });
    assert.equal(attempts, 2);
    assert.equal(result.status, 'COMPLETED');
  }
});

test('SSE connection timeout is a tool error; established streams still yield snapshots', async () => {
  const { createSseReader, collectLogSnapshot } = await import(
    '../src/specgen/clients/sse.js'
  );
  const { runTool } = await import('../src/specgen/tools/util.js');
  const silent = createSseReader({
    apiKey: 'fake',
    fetchImpl: ((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => reject(init!.signal!.reason),
          { once: true }
        );
      })) as typeof fetch,
  });
  const failed = await runTool(async () => ({
    ok: true,
    status: 200,
    payload: await collectLogSnapshot(silent, 'https://example.invalid', {
      maxWaitMs: 20,
    }),
  }));
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 504);

  for (const frame of ['', 'data: {"line":"startup complete"}\n\n']) {
    const reader = createSseReader({
      apiKey: 'fake',
      fetchImpl: (async (_url, init) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (frame) controller.enqueue(new TextEncoder().encode(frame));
              init!.signal!.addEventListener(
                'abort',
                () => controller.error(init!.signal!.reason),
                { once: true }
              );
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )) as typeof fetch,
    });
    const snapshot = await collectLogSnapshot(
      reader,
      'https://example.invalid',
      { maxWaitMs: 20 }
    );
    assert.deepEqual(
      snapshot.items,
      frame ? [{ line: 'startup complete' }] : []
    );
    assert.equal(snapshot.truncated, false);
  }
});

test('runtime empty host override uses production while a configured override is preserved', async () => {
  const { createRuntimeClient, DEFAULT_SERVERLESS_BASE_URL } = await import(
    '../src/specgen/clients/runtime.js'
  );
  const original = process.env.RUNPOD_SERVERLESS_API_URL;
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(new URL(String(input)).href);
    return new Response('{"status":"COMPLETED"}');
  }) as typeof fetch;
  try {
    for (const configured of ['', 'https://runtime.example.test/v2']) {
      process.env.RUNPOD_SERVERLESS_API_URL = configured;
      const runtime = createRuntimeClient({ apiKey: 'fake', fetchImpl });
      await runtime('ep', '/status/job');
      assert.equal(
        urls.at(-1),
        `${configured || DEFAULT_SERVERLESS_BASE_URL}/ep/status/job`
      );
    }
    await createRuntimeClient({
      apiKey: 'fake',
      baseUrl: 'https://explicit.example.test/v2',
      fetchImpl,
    })('ep', '/status/job');
    assert.equal(urls.at(-1), 'https://explicit.example.test/v2/ep/status/job');
  } finally {
    if (original === undefined) delete process.env.RUNPOD_SERVERLESS_API_URL;
    else process.env.RUNPOD_SERVERLESS_API_URL = original;
  }
});

test('plain-text runtime and primitive JSON SDK errors retain Retry-After through MCP', async () => {
  const original = globalThis.fetch;
  let responseText = 'Too Many Requests';
  globalThis.fetch = async () =>
    new Response(responseText, {
      status: 429,
      headers: { 'retry-after': '120' },
    });
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'fake', sdkRetry: false }),
    'test'
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    for (const call of [
      { name: 'run-endpoint', arguments: { endpointId: 'ep', input: {} } },
      { name: 'list-pods', arguments: {} },
    ]) {
      responseText =
        call.name === 'run-endpoint'
          ? 'Too Many Requests'
          : JSON.stringify('Too Many Requests');
      const result = await client.callTool(call);
      assert.equal(result.isError, true);
      const payload = JSON.parse(
        (result.content as Array<{ text: string }>)[0].text
      );
      assert.match(payload.hint, /120s/);
      assert.match(JSON.stringify(payload), /Too Many Requests/);
    }
  } finally {
    globalThis.fetch = original;
    await client.close();
    await server.close();
  }
});

test('stream errors retain earlier output and upstream recovery hints through MCP', async () => {
  const ctx = createToolContext({ apiKey: 'fake' });
  let polls = 0;
  ctx.runtime = async () => {
    if (++polls === 1)
      return { status: 'IN_PROGRESS', stream: [{ output: 'first chunk' }] };
    throw new HttpError('Rate limited', 429, { hint: 'Wait 60 seconds' });
  };
  const server = createSpecgenServer(ctx, 'test');
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({
      name: 'stream-job',
      arguments: { endpointId: 'ep', jobId: 'job' },
    });
    assert.equal(result.isError, true);
    const content = result.content as Array<{ text: string }>;
    const payload = JSON.parse(content[0].text);
    assert.deepEqual(payload.detail.stream, [{ output: 'first chunk' }]);
    assert.equal(payload.hint, 'Wait 60 seconds');
    assert.equal(polls, 2);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('exhausted status polling throws an upstream error with its last successful status', async () => {
  let polls = 0;
  await assert.rejects(
    pollJobStatus({
      budgetMs: 10000,
      pollIntervalMs: 1,
      fetchStatus: async () => {
        if (++polls === 1) return { status: 'IN_PROGRESS', id: 'job' };
        throw new HttpError('Unavailable', 503, {});
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.equal((error.payload as { status: string }).status, 'IN_PROGRESS');
      assert.match(error.message, /5 consecutive errors/);
      return true;
    }
  );
  assert.equal(polls, 6);
});

test('exhausted streaming polls produce an MCP tool error and preserve collected chunks', async () => {
  const ctx = createToolContext({ apiKey: 'fake' });
  let polls = 0;
  ctx.runtime = async () => {
    if (++polls === 1)
      return { status: 'IN_PROGRESS', stream: ['partial output'] };
    throw new HttpError('Unavailable', 503, {});
  };
  const server = createSpecgenServer(ctx, 'test');
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({
      name: 'stream-job',
      arguments: { endpointId: 'ep', jobId: 'job' },
    });
    assert.equal(result.isError, true);
    const payload = JSON.parse(
      (result.content as Array<{ text: string }>)[0].text
    );
    assert.deepEqual(payload.detail.stream, ['partial output']);
    assert.match(payload.error, /5 consecutive errors/);
    assert.equal(polls, 6);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('a first-poll timeout is a tool error, not a successful cold-start report', async () => {
  const ctx = createToolContext({ apiKey: 'fake' });
  ctx.runtime = async (_endpoint, _path, opts) => {
    await new Promise((resolve) => setTimeout(resolve, opts!.timeoutMs));
    throw new DOMException('Timed out', 'TimeoutError');
  };
  const { getJobStatus } = await import('../src/specgen/tools/jobs.js');
  const result = await getJobStatus.handler(ctx, {
    endpointId: 'ep',
    jobId: 'job',
    wait: 1000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 504);
  assert.match(JSON.stringify(result.payload), /Polling budget expired/);
  assert.doesNotMatch(JSON.stringify(result.payload), /cold start/);
});

test('budget-expiring stream failures retain earlier chunks and upstream status', async () => {
  const { collectJobStream } = await import('../src/specgen/tools/jobs.js');
  let polls = 0;
  await assert.rejects(
    collectJobStream({
      budgetMs: 10,
      holdMs: 10,
      pollIntervalMs: 0,
      poll: async () => {
        if (++polls === 1)
          return { status: 'IN_PROGRESS', stream: ['saved chunk'] };
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new HttpError('Unavailable', 503, {});
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, 503);
      assert.deepEqual((error.payload as { stream: string[] }).stream, [
        'saved chunk',
      ]);
      return true;
    }
  );
});

test('billing and permission failures give actionable guidance through MCP', async () => {
  for (const status of [402, 403]) {
    const ctx = createToolContext({ apiKey: 'fake' });
    ctx.runtime = async () => {
      throw new HttpError('Request rejected', status, {});
    };
    const server = createSpecgenServer(ctx, 'test');
    const client = new Client({ name: 'test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      const result = await client.callTool({
        name: 'cancel-job',
        arguments: { endpointId: 'ep', jobId: 'job' },
      });
      assert.equal(result.isError, true);
      const payload = JSON.parse(
        (result.content as Array<{ text: string }>)[0].text
      );
      assert.match(payload.hint, /Runpod console/);
      assert.match(payload.hint, status === 402 ? /balance/ : /permission/);
      assert.doesNotMatch(payload.hint, /get-billing/);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  }
});
