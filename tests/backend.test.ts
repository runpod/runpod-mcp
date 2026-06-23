import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  unwrapList,
  resolveVersion,
  createV2Prober,
  resolveBackend,
  type Resource,
} from '../src/_shared/backend.js';

// ============== A0: unwrapList ==============
describe('unwrapList', () => {
  it('v1: returns a bare array unchanged', () => {
    const arr = [{ id: 'a' }, { id: 'b' }];
    assert.deepEqual(unwrapList('pods', 'v1', arr), arr);
  });

  it('v1: non-array → [] (never passes a non-array to the cap)', () => {
    assert.deepEqual(unwrapList('pods', 'v1', { pods: [] }), []);
    assert.deepEqual(unwrapList('pods', 'v1', null), []);
  });

  it('v2: unwraps the per-resource envelope key', () => {
    const cases: Array<[Resource, string]> = [
      ['pods', 'pods'],
      ['templates', 'templates'],
      ['networkVolumes', 'networkVolumes'],
      ['registries', 'registries'],
      ['gpus', 'gpus'],
      ['cpus', 'cpus'],
      ['dataCenters', 'dataCenters'],
    ];
    for (const [resource, key] of cases) {
      const inner = [{ id: '1' }];
      assert.deepEqual(
        unwrapList(resource, 'v2', { [key]: inner }),
        inner,
        `resource ${resource} should unwrap key ${key}`
      );
    }
  });

  it('v2: empty envelope → empty array (not passthrough)', () => {
    assert.deepEqual(unwrapList('pods', 'v2', { pods: [] }), []);
  });

  it('v2: missing key → []', () => {
    assert.deepEqual(unwrapList('pods', 'v2', { somethingElse: [] }), []);
  });

  it('v2: non-object → []', () => {
    assert.deepEqual(unwrapList('pods', 'v2', null), []);
    assert.deepEqual(unwrapList('pods', 'v2', 'nope'), []);
    assert.deepEqual(unwrapList('pods', 'v2', [1, 2]), []);
  });
});

// ============== A1: resolveVersion ==============
describe('resolveVersion', () => {
  const stdio = { transport: 'stdio' as const };
  const http = { transport: 'http' as const };

  it('jobs and endpoints are always v1, regardless of env', () => {
    const env = { RUNPOD_REST_VERSION: 'v2' };
    assert.equal(resolveVersion({ resource: 'jobs', env, ctx: stdio }), 'v1');
    assert.equal(
      resolveVersion({ resource: 'endpoints', env, ctx: stdio }),
      'v1'
    );
  });

  it('control-plane follows RUNPOD_REST_VERSION', () => {
    assert.equal(
      resolveVersion({
        resource: 'pods',
        env: { RUNPOD_REST_VERSION: 'v2' },
        ctx: stdio,
      }),
      'v2'
    );
    assert.equal(
      resolveVersion({
        resource: 'pods',
        env: { RUNPOD_REST_VERSION: 'v1' },
        ctx: stdio,
      }),
      'v1'
    );
  });

  it('unset defaults to v1', () => {
    assert.equal(
      resolveVersion({ resource: 'pods', env: {}, ctx: stdio }),
      'v1'
    );
  });

  it('per-resource override beats the global', () => {
    const env = { RUNPOD_REST_VERSION: 'v1', RUNPOD_REST_VERSION_PODS: 'v2' };
    assert.equal(resolveVersion({ resource: 'pods', env, ctx: stdio }), 'v2');
    // a resource without an override inherits the global
    assert.equal(
      resolveVersion({ resource: 'templates', env, ctx: stdio }),
      'v1'
    );
  });

  it('auto + http → v1 (no per-request probe on hosted)', () => {
    const env = { RUNPOD_REST_VERSION: 'auto' };
    assert.equal(
      resolveVersion({ resource: 'pods', env, ctx: http, probe: () => true }),
      'v1'
    );
  });

  it('auto + stdio → probe verdict', () => {
    const env = { RUNPOD_REST_VERSION: 'auto' };
    assert.equal(
      resolveVersion({ resource: 'pods', env, ctx: stdio, probe: () => true }),
      'v2'
    );
    assert.equal(
      resolveVersion({ resource: 'pods', env, ctx: stdio, probe: () => false }),
      'v1'
    );
  });
});

// ============== A1b: createV2Prober (injected fetch, no network) ==============
describe('createV2Prober', () => {
  const mkFetch = (status: number, calls?: { n: number }) => async () => {
    if (calls) calls.n++;
    return { status };
  };

  it('2xx → true', async () => {
    const probe = createV2Prober({
      fetch: mkFetch(200),
      baseUrl: 'x',
      apiKey: 'k',
    });
    assert.equal(await probe(), true);
  });

  it('401 → false', async () => {
    const probe = createV2Prober({
      fetch: mkFetch(401),
      baseUrl: 'x',
      apiKey: 'k',
    });
    assert.equal(await probe(), false);
  });

  it('fetch throws → false', async () => {
    const probe = createV2Prober({
      fetch: async () => {
        throw new Error('network down');
      },
      baseUrl: 'x',
      apiKey: 'k',
    });
    assert.equal(await probe(), false);
  });

  it('memoizes: fetch called once across multiple calls', async () => {
    const calls = { n: 0 };
    const probe = createV2Prober({
      fetch: mkFetch(200, calls),
      baseUrl: 'x',
      apiKey: 'k',
    });
    await probe();
    await probe();
    await probe();
    assert.equal(calls.n, 1);
  });
});

// ============== A2: resolveBackend (v1 descriptors) ==============
describe('resolveBackend (v1)', () => {
  const stdio = { transport: 'stdio' as const };
  const env = {}; // all defaults

  it('pods → REST v1 base + exact today paths + identity mappers', () => {
    const b = resolveBackend({ resource: 'pods', env, ctx: stdio });
    assert.equal(b.kind, 'rest');
    assert.equal(b.version, 'v1');
    assert.equal(b.base, 'https://rest.runpod.io/v1');
    assert.equal(b.list, '/pods');
    assert.equal(b.get!('pod_x'), '/pods/pod_x');
  });

  it('exact v1 list paths per resource', () => {
    const expect: Array<[Resource, string]> = [
      ['pods', '/pods'],
      ['templates', '/templates'],
      ['networkVolumes', '/networkvolumes'],
      ['registries', '/containerregistryauth'],
      ['endpoints', '/endpoints'],
    ];
    for (const [resource, list] of expect) {
      const b = resolveBackend({ resource, env, ctx: stdio });
      assert.equal(b.list, list, `${resource} list path`);
    }
  });

  it('identity mappers under v1', () => {
    const b = resolveBackend({ resource: 'pods', env, ctx: stdio });
    const body = { imageName: 'img', gpuCount: 2 };
    assert.deepEqual(b.mapCreate(body), body);
    assert.deepEqual(b.mapUpdate(body), body);
  });

  it('unwrap is wired to v1 passthrough', () => {
    const b = resolveBackend({ resource: 'pods', env, ctx: stdio });
    const arr = [{ id: '1' }];
    assert.deepEqual(b.unwrap(arr), arr);
  });

  it('jobs → serverless base', () => {
    const b = resolveBackend({ resource: 'jobs', env, ctx: stdio });
    assert.equal(b.base, 'https://api.runpod.ai/v2');
    assert.equal(b.kind, 'rest');
  });

  it('catalog (gpus/cpus/dataCenters) → graphql kind under v1', () => {
    for (const resource of ['gpus', 'cpus', 'dataCenters'] as Resource[]) {
      const b = resolveBackend({ resource, env, ctx: stdio });
      assert.equal(b.kind, 'graphql', `${resource} kind`);
      assert.equal(b.base, 'https://api.runpod.io/graphql');
    }
  });

  it('endpoints uses the REST v1 base, NOT the serverless base', () => {
    const b = resolveBackend({ resource: 'endpoints', env, ctx: stdio });
    assert.equal(b.base, 'https://rest.runpod.io/v1');
  });

  it('env overrides bases', () => {
    const b = resolveBackend({
      resource: 'pods',
      env: { RUNPOD_REST_API_URL: 'http://localhost:9999/v1' },
      ctx: stdio,
    });
    assert.equal(b.base, 'http://localhost:9999/v1');
  });

  it('v2 resolution throws until Phase B (keeps Phase A v1-only honest)', () => {
    assert.throws(
      () =>
        resolveBackend({
          resource: 'pods',
          env: { RUNPOD_REST_VERSION: 'v2' },
          ctx: stdio,
        }),
      /not implemented until Phase B/
    );
  });
});
