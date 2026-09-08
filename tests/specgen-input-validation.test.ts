import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getJobStatus,
  runsyncEndpoint,
  STATUS_WAIT_MAX_MS,
  HOSTED,
} from '../src/specgen/tools/jobs.js';
import { buildHubEnv, deployHubRepo } from '../src/specgen/tools/hub.js';
import type { ToolContext } from '../src/specgen/context.js';

test('malformed waits fail before either job tool calls an API', async () => {
  let calls = 0;
  const ctx = {
    runtime: async () => {
      calls++;
      return { status: 'COMPLETED' };
    },
  } as unknown as ToolContext;
  for (const tool of [getJobStatus, runsyncEndpoint]) {
    for (const wait of [
      '1000',
      'invalid',
      null,
      false,
      {},
      [],
      NaN,
      Infinity,
      -Infinity,
      -1,
      0,
      999,
    ]) {
      const result = await tool.handler(ctx, {
        endpointId: 'ep',
        jobId: 'job',
        input: {},
        wait,
      });
      assert.equal(result.ok, false, `${tool.name}: ${String(wait)}`);
      assert.equal(result.status, 400);
      assert.match(
        JSON.stringify(result.payload),
        /wait must be a finite number/
      );
    }
  }
  assert.equal(calls, 0);
});

test('valid and omitted waits retain defaults and respect the transport ceiling', async () => {
  for (const tool of [getJobStatus, runsyncEndpoint]) {
    for (const wait of [undefined, 1000, 1500.5, STATUS_WAIT_MAX_MS * 2]) {
      const calls: Array<{ path: string; timeoutMs?: number }> = [];
      const ctx = {
        runtime: async (
          _id: string,
          path: string,
          opts?: { timeoutMs?: number }
        ) => {
          calls.push({ path, timeoutMs: opts?.timeoutMs });
          return { status: 'COMPLETED' };
        },
      } as unknown as ToolContext;
      const result = await tool.handler(ctx, {
        endpointId: 'ep',
        jobId: 'job',
        input: {},
        ...(wait === undefined ? {} : { wait }),
      });
      assert.equal(result.ok, true);
      assert.equal(calls.length, 1);
      if (tool === runsyncEndpoint) {
        const expected =
          wait === undefined
            ? HOSTED
              ? STATUS_WAIT_MAX_MS
              : undefined
            : Math.min(wait, STATUS_WAIT_MAX_MS);
        assert.equal(
          calls[0].path,
          expected === undefined ? '/runsync' : `/runsync?wait=${expected}`
        );
        assert.equal(calls[0].timeoutMs, (expected ?? 90000) + 5000);
      } else if (wait === undefined) {
        assert.equal(calls[0].timeoutMs, undefined);
      } else {
        assert.ok(Number.isFinite(calls[0].timeoutMs));
        assert.ok(calls[0].timeoutMs! <= STATUS_WAIT_MAX_MS);
      }
    }
  }
});

test('Hub validates required values after defaults and boolean serialization', () => {
  const config = {
    env: [
      { key: 'HF_TOKEN', input: { required: true, default: '' } },
      {
        key: 'FLAG',
        input: {
          required: true,
          type: 'boolean',
          default: false,
          falseValue: '0',
        },
      },
      { key: 'COUNT', input: { required: true, default: 0 } },
      { key: 'OPTIONAL', input: { default: '' } },
      {
        key: 'MAPPED_EMPTY',
        input: {
          required: true,
          type: 'boolean',
          default: true,
          trueValue: '',
        },
      },
    ],
  };
  const result = buildHubEnv(config, {});
  assert.deepEqual(result.missingRequired, ['HF_TOKEN', 'MAPPED_EMPTY']);
  assert.deepEqual(
    Object.fromEntries(result.env.map((e) => [e.key, e.value])),
    {
      HF_TOKEN: '',
      FLAG: '0',
      COUNT: '0',
      OPTIONAL: '',
      MAPPED_EMPTY: '',
    }
  );
  assert.deepEqual(
    buildHubEnv(config, { HF_TOKEN: 'fake-value', MAPPED_EMPTY: 'literal' })
      .missingRequired,
    []
  );
  assert.deepEqual(
    buildHubEnv(
      { env: [{ key: 'X', input: { required: true, default: 'fallback' } }] },
      { X: '' }
    ),
    {
      env: [{ key: 'X', value: 'fallback' }],
      missingRequired: [],
    }
  );
});

test('Hub deployment refuses empty required defaults before any creation', async () => {
  let creations = 0;
  const ctx = {
    graphql: {
      public: async () => ({
        listings: [
          {
            repoOwner: 'fake',
            repoName: 'worker',
            type: 'SERVERLESS',
            title: 'Fake',
            listedRelease: {
              id: 'release',
              tagName: 'v1',
              build: { imageName: 'fake/image' },
              config: JSON.stringify({
                gpuIds: 'ADA_24',
                env: [
                  { key: 'HF_TOKEN', input: { required: true, default: '' } },
                ],
              }),
            },
          },
        ],
      }),
      authed: async () => {
        creations++;
        return { saveEndpoint: { id: 'fake-endpoint' } };
      },
    },
  } as unknown as ToolContext;
  const failed = await deployHubRepo.handler(ctx, { repo: 'fake/worker' });
  assert.equal(failed.status, 400);
  assert.match(JSON.stringify(failed.payload), /Missing required.*HF_TOKEN/);
  assert.equal(creations, 0);
  const valid = await deployHubRepo.handler(ctx, {
    repo: 'fake/worker',
    env: { HF_TOKEN: 'fake-value' },
  });
  assert.equal(valid.ok, true);
  assert.equal(creations, 1);
});
