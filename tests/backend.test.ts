import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  unwrapList,
  resolveVersion,
  createV2Prober,
  resolveBackend,
  wantsAutoProbe,
  type Resource,
} from '../src/_shared/backend.js';

describe('wantsAutoProbe', () => {
  it('true when the global flag is auto (any case)', () => {
    assert.equal(wantsAutoProbe({ RUNPOD_REST_VERSION: 'auto' }), true);
    assert.equal(wantsAutoProbe({ RUNPOD_REST_VERSION: 'AUTO' }), true);
  });
  it('true when a per-resource override is auto', () => {
    assert.equal(wantsAutoProbe({ RUNPOD_REST_VERSION_PODS: 'auto' }), true);
  });
  it('false for v1/v2/unset/bogus/empty', () => {
    assert.equal(wantsAutoProbe({ RUNPOD_REST_VERSION: 'v2' }), false);
    assert.equal(wantsAutoProbe({ RUNPOD_REST_VERSION: 'v1' }), false);
    assert.equal(wantsAutoProbe({}), false);
    assert.equal(wantsAutoProbe({ RUNPOD_REST_VERSION: 'foo' }), false);
    assert.equal(wantsAutoProbe({ RUNPOD_REST_VERSION: '' }), false);
  });
  it('startsWith matches any suffix incl. V1_ONLY (intentional over-match; harmless)', () => {
    assert.equal(
      wantsAutoProbe({ RUNPOD_REST_VERSION_ENDPOINTS: 'auto' }),
      true
    );
  });
});

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

  it('undefined raw → [] for both versions', () => {
    assert.deepEqual(unwrapList('pods', 'v1', undefined), []);
    assert.deepEqual(unwrapList('pods', 'v2', undefined), []);
  });
});

// ============== A1: resolveVersion ==============
describe('resolveVersion', () => {
  const stdio = { transport: 'stdio' as const };
  const http = { transport: 'http' as const };

  it('jobs is always v1, regardless of env (serverless runtime, no v2 home)', () => {
    const env = { RUNPOD_REST_VERSION: 'v2' };
    assert.equal(resolveVersion({ resource: 'jobs', env, ctx: stdio }), 'v1');
  });

  it('endpoints follow the version flag (v2 → /v2/serverless, v1 → /endpoints)', () => {
    assert.equal(
      resolveVersion({
        resource: 'endpoints',
        env: { RUNPOD_REST_VERSION: 'v2' },
        ctx: stdio,
      }),
      'v2'
    );
    assert.equal(
      resolveVersion({
        resource: 'endpoints',
        env: { RUNPOD_REST_VERSION: 'v1' },
        ctx: stdio,
      }),
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

  it('unset defaults to v2 (the local default)', () => {
    assert.equal(
      resolveVersion({ resource: 'pods', env: {}, ctx: stdio }),
      'v2'
    );
  });

  it('per-resource override beats the global (v2 over v1)', () => {
    const env = { RUNPOD_REST_VERSION: 'v1', RUNPOD_REST_VERSION_PODS: 'v2' };
    assert.equal(resolveVersion({ resource: 'pods', env, ctx: stdio }), 'v2');
    // a resource without an override inherits the global
    assert.equal(
      resolveVersion({ resource: 'templates', env, ctx: stdio }),
      'v1'
    );
  });

  it('per-resource override beats the global (v1 over v2)', () => {
    const env = { RUNPOD_REST_VERSION: 'v2', RUNPOD_REST_VERSION_PODS: 'v1' };
    assert.equal(resolveVersion({ resource: 'pods', env, ctx: stdio }), 'v1');
    assert.equal(
      resolveVersion({ resource: 'templates', env, ctx: stdio }),
      'v2'
    );
  });

  it('bogus RUNPOD_REST_VERSION falls back to v1', () => {
    assert.equal(
      resolveVersion({
        resource: 'pods',
        env: { RUNPOD_REST_VERSION: 'foo' },
        ctx: stdio,
      }),
      'v1'
    );
  });

  it('is case-insensitive (V2, AUTO)', () => {
    assert.equal(
      resolveVersion({
        resource: 'pods',
        env: { RUNPOD_REST_VERSION: 'V2' },
        ctx: stdio,
      }),
      'v2'
    );
    assert.equal(
      resolveVersion({
        resource: 'pods',
        env: { RUNPOD_REST_VERSION: 'AUTO' },
        ctx: stdio,
        v2Available: true,
      }),
      'v2'
    );
  });

  it('auto + http → v1 (no per-request probe on hosted)', () => {
    const env = { RUNPOD_REST_VERSION: 'auto' };
    assert.equal(
      resolveVersion({ resource: 'pods', env, ctx: http, v2Available: true }),
      'v1'
    );
  });

  it('auto + stdio → uses the resolved v2Available verdict', () => {
    const env = { RUNPOD_REST_VERSION: 'auto' };
    assert.equal(
      resolveVersion({ resource: 'pods', env, ctx: stdio, v2Available: true }),
      'v2'
    );
    assert.equal(
      resolveVersion({ resource: 'pods', env, ctx: stdio, v2Available: false }),
      'v1'
    );
  });

  it('auto + stdio with no v2Available → v1 (conservative default)', () => {
    assert.equal(
      resolveVersion({
        resource: 'pods',
        env: { RUNPOD_REST_VERSION: 'auto' },
        ctx: stdio,
      }),
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

  it('any 2xx → available (204 included); 3xx → not (pins the < 300 bound)', async () => {
    for (const status of [200, 204, 299]) {
      const probe = createV2Prober({
        fetch: mkFetch(status),
        baseUrl: 'x',
        apiKey: 'k',
      });
      assert.equal(await probe(), true, `status ${status} should be available`);
    }
    for (const status of [300, 301, 404]) {
      const probe = createV2Prober({
        fetch: mkFetch(status),
        baseUrl: 'x',
        apiKey: 'k',
      });
      assert.equal(
        await probe(),
        false,
        `status ${status} should not be available`
      );
    }
  });

  it('passes an AbortSignal (timeout) and degrades an aborted probe to false', async () => {
    let sawSignal = false;
    const probe = createV2Prober({
      fetch: async (_url, init) => {
        sawSignal = init?.signal instanceof AbortSignal;
        throw new Error('aborted'); // simulate a timeout abort
      },
      baseUrl: 'x',
      apiKey: 'k',
      timeoutMs: 10,
    });
    assert.equal(await probe(), false);
    assert.equal(sawSignal, true, 'probe must pass a timeout signal');
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

  it('sends GET to <base>/catalog/gpus with bearer auth', async () => {
    let seen: {
      url?: string;
      init?: { method?: string; headers?: Record<string, string> };
    } = {};
    const probe = createV2Prober({
      fetch: async (url, init) => {
        seen = { url, init };
        return { status: 200 };
      },
      baseUrl: 'https://v2-rest.runpod.dev/v2',
      apiKey: 'rpa_xyz',
    });
    await probe();
    assert.equal(seen.url, 'https://v2-rest.runpod.dev/v2/catalog/gpus');
    assert.equal(seen.init?.method, 'GET');
    assert.equal(seen.init?.headers?.Authorization, 'Bearer rpa_xyz');
  });

  it('memoizes a true verdict: fetch called once across calls', async () => {
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

  it('does NOT cache a 401/403 verdict — re-probes and can recover', async () => {
    // 401/403 is treated as transient (not definitive): an auth failure during a
    // rollout, or a key whose v2 scope is later expanded, must not pin the
    // process to v1 for its lifetime. Each call returns false but re-probes.
    let status = 401;
    const calls = { n: 0 };
    const probe = createV2Prober({
      fetch: () => {
        calls.n++;
        return Promise.resolve({ status });
      },
      baseUrl: 'x',
      apiKey: 'k',
    });
    assert.equal(await probe(), false);
    assert.equal(calls.n, 1);
    status = 200; // v2 access granted later
    assert.equal(await probe(), true, '401 must not be cached — can recover');
    assert.equal(calls.n, 2);
  });

  it('does NOT cache a transient failure (5xx) — re-probes and can recover', async () => {
    let status = 503;
    const calls = { n: 0 };
    const probe = createV2Prober({
      fetch: async () => {
        calls.n++;
        return { status };
      },
      baseUrl: 'x',
      apiKey: 'k',
    });
    assert.equal(await probe(), false); // 5xx → false, not cached
    status = 200;
    assert.equal(await probe(), true, 'recovers once the endpoint is healthy');
    assert.equal(calls.n, 2);
  });

  it('does NOT cache a thrown error — re-probes', async () => {
    let throwIt = true;
    const calls = { n: 0 };
    const probe = createV2Prober({
      fetch: async () => {
        calls.n++;
        if (throwIt) throw new Error('blip');
        return { status: 200 };
      },
      baseUrl: 'x',
      apiKey: 'k',
    });
    assert.equal(await probe(), false);
    throwIt = false;
    assert.equal(await probe(), true);
    assert.equal(calls.n, 2);
  });
});

// ============== A2: resolveBackend (v1 descriptors) ==============
describe('resolveBackend (v1)', () => {
  const stdio = { transport: 'stdio' as const };
  // Pin v1 explicitly so these v1-descriptor assertions hold regardless of the
  // code's default version (the local default is v2 — tests must not rely on it).
  const env = { RUNPOD_REST_VERSION: 'v1' };

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

  it('identity mappers under v1 (same reference, true passthrough)', () => {
    const b = resolveBackend({ resource: 'pods', env, ctx: stdio });
    const body = { imageName: 'img', gpuCount: 2 };
    assert.equal(b.mapCreate(body), body); // reference equality pins identity
    assert.equal(b.mapUpdate(body), body);
  });

  it('get(id) interpolates id for every REST resource', () => {
    const expect: Array<[Resource, string]> = [
      ['pods', '/pods/X'],
      ['templates', '/templates/X'],
      ['networkVolumes', '/networkvolumes/X'],
      ['registries', '/containerregistryauth/X'],
      ['endpoints', '/endpoints/X'],
    ];
    for (const [resource, path] of expect) {
      const b = resolveBackend({ resource, env, ctx: stdio });
      assert.equal(b.get!('X'), path, `${resource} get path`);
    }
  });

  it('unwrap is wired to v1 passthrough', () => {
    const b = resolveBackend({ resource: 'pods', env, ctx: stdio });
    const arr = [{ id: '1' }];
    assert.deepEqual(b.unwrap(arr), arr);
  });

  it('jobs → serverless base, no list/get path, v1', () => {
    const b = resolveBackend({ resource: 'jobs', env, ctx: stdio });
    assert.equal(b.base, 'https://api.runpod.ai/v2');
    assert.equal(b.kind, 'rest');
    assert.equal(b.version, 'v1');
    assert.equal(b.list, undefined);
    assert.equal(b.get, undefined);
    assert.deepEqual(b.unwrap([{ id: 'j' }]), [{ id: 'j' }]); // v1 passthrough
  });

  it('catalog (gpus/cpus/dataCenters) → graphql kind, no path, v1', () => {
    for (const resource of ['gpus', 'cpus', 'dataCenters'] as Resource[]) {
      const b = resolveBackend({ resource, env, ctx: stdio });
      assert.equal(b.kind, 'graphql', `${resource} kind`);
      assert.equal(b.base, 'https://api.runpod.io/graphql');
      assert.equal(b.version, 'v1');
      assert.equal(b.list, undefined, `${resource} should expose no list path`);
      assert.equal(b.get, undefined, `${resource} should expose no get path`);
    }
  });

  it('endpoints uses the REST v1 base, NOT the serverless base', () => {
    const b = resolveBackend({ resource: 'endpoints', env, ctx: stdio });
    assert.equal(b.base, 'https://rest.runpod.io/v1');
  });

  it('env overrides the REST base', () => {
    const b = resolveBackend({
      resource: 'pods',
      env: {
        RUNPOD_REST_VERSION: 'v1',
        RUNPOD_REST_API_URL: 'http://localhost:9999/v1',
      },
      ctx: stdio,
    });
    assert.equal(b.base, 'http://localhost:9999/v1');
  });

  it('env overrides the serverless base (jobs)', () => {
    const b = resolveBackend({
      resource: 'jobs',
      env: { RUNPOD_SERVERLESS_API_URL: 'http://localhost:8/v2' },
      ctx: stdio,
    });
    assert.equal(b.base, 'http://localhost:8/v2');
  });

  it('env overrides the graphql base (catalog)', () => {
    const b = resolveBackend({
      resource: 'gpus',
      env: {
        RUNPOD_REST_VERSION: 'v1',
        RUNPOD_PUBLIC_GRAPHQL_URL: 'http://localhost:8/graphql',
      },
      ctx: stdio,
    });
    assert.equal(b.base, 'http://localhost:8/graphql');
  });

  it('every resource resolves under v1 default env without throwing', () => {
    // Includes the v2-only resources (tags/workers/billing): under v1 they must
    // resolve to the stub backend, NOT throw on a missing v1 path table entry.
    const all: Resource[] = [
      'pods',
      'templates',
      'networkVolumes',
      'registries',
      'gpus',
      'cpus',
      'dataCenters',
      'endpoints',
      'jobs',
      'tags',
      'workers',
      'billing',
    ];
    for (const resource of all) {
      assert.doesNotThrow(
        () => resolveBackend({ resource, env, ctx: stdio }),
        `${resource} should resolve under v1`
      );
    }
  });

  it('v2-only resources resolve to a v1 stub (version v1, no list/get) under v1', () => {
    for (const resource of ['tags', 'workers', 'billing'] as Resource[]) {
      const b = resolveBackend({ resource, env, ctx: stdio });
      assert.equal(b.version, 'v1', `${resource} version`);
      assert.equal(b.list, undefined, `${resource} has no v1 list path`);
      assert.equal(b.get, undefined, `${resource} has no v1 get path`);
    }
  });

  it('auto + no v2Available → v1 descriptor (does not throw)', () => {
    assert.doesNotThrow(() =>
      resolveBackend({
        resource: 'pods',
        env: { RUNPOD_REST_VERSION: 'auto' },
        ctx: stdio,
      })
    );
  });

  it('forwards v2Available through to resolveVersion (auto+stdio→v2 descriptor)', () => {
    const b = resolveBackend({
      resource: 'pods',
      env: { RUNPOD_REST_VERSION: 'auto' },
      ctx: stdio,
      v2Available: true,
    });
    assert.equal(b.version, 'v2');
    assert.equal(b.base, 'https://v2-rest.runpod.io/v2');
  });
});

describe('resolveBackend (v2 descriptors)', () => {
  const stdio = { transport: 'stdio' as const };
  const v2env = { RUNPOD_REST_VERSION: 'v2' };

  it('exact v2 paths per resource (relative to /v2 base) + correct COMBINED url', () => {
    // paths are relative to a base that already includes /v2 — base+list must
    // NOT double the /v2 (regression guard for the wiring bug).
    const expect: Array<[Resource, string, string | undefined]> = [
      ['pods', '/pods', '/pods/X'],
      ['templates', '/templates', '/templates/X'],
      ['networkVolumes', '/network-volumes', '/network-volumes/X'],
      ['registries', '/registries', '/registries/X'],
      ['gpus', '/catalog/gpus', '/catalog/gpus/X'],
      ['cpus', '/catalog/cpus', '/catalog/cpus/X'],
      ['dataCenters', '/catalog/datacenters', '/catalog/datacenters/X'],
      ['tags', '/tags', '/tags/X'],
      ['workers', '/serverless', undefined],
      ['billing', '/billing', undefined],
    ];
    for (const [resource, list, get] of expect) {
      const b = resolveBackend({ resource, env: v2env, ctx: stdio });
      assert.equal(b.version, 'v2', `${resource} version`);
      assert.equal(b.base, 'https://v2-rest.runpod.io/v2', `${resource} base`);
      assert.equal(b.kind, 'rest', `${resource} kind (catalog is REST in v2)`);
      assert.equal(b.list, list, `${resource} list`);
      assert.equal(get ? b.get!('X') : b.get, get, `${resource} get`);
      // the combined URL is exactly one /v2 segment (list AND get + action)
      assert.equal(
        b.base + b.list,
        `https://v2-rest.runpod.io/v2${list}`,
        `${resource} combined list url`
      );
      if (b.get) {
        assert.equal(
          b.base + b.get('X'),
          `https://v2-rest.runpod.io/v2${get}`,
          `${resource} combined get url`
        );
        assert.equal(
          (b.base + b.get('X') + '/action').includes('/v2/v2'),
          false,
          `${resource} action url must not double /v2`
        );
      }
    }
  });

  it('v2 base is env-overridable', () => {
    const b = resolveBackend({
      resource: 'pods',
      env: {
        RUNPOD_REST_VERSION: 'v2',
        RUNPOD_REST_V2_API_URL: 'http://local/v2',
      },
      ctx: stdio,
    });
    assert.equal(b.base, 'http://local/v2');
  });

  it('v2 unwrap pulls the envelope key', () => {
    const b = resolveBackend({ resource: 'pods', env: v2env, ctx: stdio });
    assert.deepEqual(b.unwrap({ pods: [{ id: 'p' }] }), [{ id: 'p' }]);
    const t = resolveBackend({ resource: 'templates', env: v2env, ctx: stdio });
    assert.deepEqual(t.unwrap({ templates: [1, 2] }), [1, 2]);
  });

  it('v2 mapCreate is wired (pods remap; registries identity)', () => {
    const pods = resolveBackend({ resource: 'pods', env: v2env, ctx: stdio });
    const mapped = pods.mapCreate({ imageName: 'i' }) as Record<
      string,
      unknown
    >;
    assert.equal(mapped.image, 'i');
    assert.equal('imageName' in mapped, false);

    const reg = resolveBackend({
      resource: 'registries',
      env: v2env,
      ctx: stdio,
    });
    const body = { name: 'r', username: 'u', password: 'p' };
    assert.deepEqual(reg.mapCreate(body), body); // identity
  });

  it('per-resource override yields a v2 descriptor while siblings stay v1', () => {
    const env = { RUNPOD_REST_VERSION: 'v1', RUNPOD_REST_VERSION_PODS: 'v2' };
    const pods = resolveBackend({ resource: 'pods', env, ctx: stdio });
    assert.equal(pods.version, 'v2');
    assert.equal(pods.base, 'https://v2-rest.runpod.io/v2');
    assert.equal(pods.list, '/pods');
    assert.equal(pods.base + pods.list, 'https://v2-rest.runpod.io/v2/pods');
    assert.equal(
      (pods.mapCreate({ imageName: 'i' }) as Record<string, unknown>).image,
      'i'
    );
    const templates = resolveBackend({
      resource: 'templates',
      env,
      ctx: stdio,
    });
    assert.equal(templates.version, 'v1');
    assert.equal(templates.base, 'https://rest.runpod.io/v1');
    assert.equal(templates.list, '/templates');
  });

  it('jobs stays v1 even under RUNPOD_REST_VERSION=v2 (serverless runtime)', () => {
    const jobs = resolveBackend({ resource: 'jobs', env: v2env, ctx: stdio });
    assert.equal(jobs.version, 'v1');
    assert.equal(jobs.base, 'https://api.runpod.ai/v2'); // serverless, not v2 REST
  });

  it('endpoints resolve to the v2 /serverless descriptor under v2', () => {
    const ep = resolveBackend({
      resource: 'endpoints',
      env: v2env,
      ctx: stdio,
    });
    assert.equal(ep.version, 'v2');
    assert.equal(ep.base, 'https://v2-rest.runpod.io/v2');
    assert.equal(ep.list, '/serverless');
    assert.equal(ep.get!('X'), '/serverless/X');
  });
});
