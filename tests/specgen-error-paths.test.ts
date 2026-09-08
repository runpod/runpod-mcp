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
