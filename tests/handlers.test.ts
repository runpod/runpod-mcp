import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Defense-in-depth: the v1 goldens assume the version env vars are unset. Clear
// them before every test so a leak (from another test or the CI env) can't
// silently flip v1 goldens to v2.
beforeEach(() => {
  // Clear the global flag AND every per-resource override (RUNPOD_REST_VERSION_*)
  // so a leak from CI/shell can't flip v1 goldens to v2 (or route a v1 catalog
  // test to the real-network GraphQL path).
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('RUNPOD_REST_VERSION')) delete process.env[k];
  }
  // Pin this process.env-based suite to v1 by default so the "v1 unchanged"
  // goldens assert v1 regardless of the code's default version — the suite
  // stays correct whether the local default is v1 or v2. v2 cases opt in
  // explicitly via withV2(...).
  process.env.RUNPOD_REST_VERSION = 'v1';
});

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';
import { HttpError } from '../src/_shared/http.js';

// ============== Handler integration / outbound-request golden ==============
// Drives the REAL registerTools against a fake McpServer (captures handlers) and
// an injected fake fetch (captures the outbound {url, method, body}). This is the
// A5 regression lock: it pins what each tool puts ON THE WIRE, which an
// output-only diff cannot see. All offline — no network, no real fetch.

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

interface OutboundRecord {
  url: string;
  method: string;
  body?: string;
}

function harness(opts?: {
  // What the fake fetch returns (defaults to an empty JSON array — a v1 list).
  jsonBody?: unknown;
  // A queue of bodies returned one-per-call (for poll loops like stream-job).
  jsonBodies?: unknown[];
  status?: number;
  contentType?: string;
}) {
  const handlers = new Map<string, Handler>();
  const outbound: OutboundRecord[] = [];

  const fakeServer = {
    // registerTools calls server.tool(name, [description], schema, handler).
    // The handler is always the LAST argument.
    tool(name: string, ...args: unknown[]) {
      const last = args.at(-1);
      if (typeof last === 'function') handlers.set(name, last as Handler);
    },
    // trackingHeaders reads this per request.
    server: {
      getClientVersion: () => ({ name: 'test-client', version: '9.9.9' }),
    },
  } as unknown as McpServer;

  const status = opts?.status ?? 200;
  const queue = opts?.jsonBodies ? [...opts.jsonBodies] : null;
  const fakeFetch = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ) => {
    outbound.push({ url, method: init.method, body: init.body });
    const jsonBody = queue
      ? (queue.shift() ?? opts?.jsonBody ?? [])
      : (opts?.jsonBody ?? []);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (n: string) =>
          n.toLowerCase() === 'content-type'
            ? (opts?.contentType ?? 'application/json')
            : null,
      },
      json: async () => jsonBody,
      text: async () => '',
    };
  };

  registerTools(
    fakeServer,
    { apiKey: 'rpa_test', transport: 'stdio' },
    { fetch: fakeFetch as Parameters<typeof registerTools>[2]['fetch'] }
  );

  return { handlers, outbound };
}

describe('outbound-request golden (v1 unchanged)', () => {
  it('list-pods → GET <rest>/v1/pods, no body', async () => {
    const { handlers, outbound } = harness({ jsonBody: [] });
    await handlers.get('list-pods')!({});
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/pods');
    assert.equal(outbound[0].method, 'GET');
    assert.equal(outbound[0].body, undefined);
  });

  it('list-pods forwards filter query params (verbatim encoding)', async () => {
    const { handlers, outbound } = harness({ jsonBody: [] });
    await handlers.get('list-pods')!({
      computeType: 'GPU',
      gpuTypeId: ['A', 'B'],
      includeMachine: true,
    });
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/pods?computeType=GPU&gpuTypeId=A&gpuTypeId=B&includeMachine=true'
    );
  });

  it('get-pod → GET <rest>/v1/pods/{id}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('get-pod')!({ podId: 'pod_123' });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/pods/pod_123');
    assert.equal(outbound[0].method, 'GET');
  });

  it('create-pod → POST <rest>/v1/pods with body BYTE-IDENTICAL to params (v1 passthrough)', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    const params = {
      name: 'p',
      imageName: 'img:1',
      gpuTypeIds: ['NVIDIA A100'],
      gpuCount: 2,
      containerDiskInGb: 20,
      env: { K: 'V' },
    };
    await handlers.get('create-pod')!({ ...params });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/pods');
    assert.equal(outbound[0].method, 'POST');
    assert.equal(outbound[0].body, JSON.stringify(params));
  });

  it('stop-pod → POST <rest>/v1/pods/{id}/stop', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('stop-pod')!({ podId: 'pod_9' });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/pods/pod_9/stop');
    assert.equal(outbound[0].method, 'POST');
  });

  it('delete-pod → DELETE <rest>/v1/pods/{id}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('delete-pod')!({ podId: 'pod_x' });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/pods/pod_x');
    assert.equal(outbound[0].method, 'DELETE');
  });

  it('restart-pod registers and under v1 returns a clean "v2 only" message (no request)', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    assert.ok(handlers.has('restart-pod'), 'restart-pod must be registered');
    const out = (await handlers.get('restart-pod')!({ podId: 'pod_r' })) as {
      content: Array<{ text: string }>;
    };
    assert.equal(
      outbound.length,
      0,
      'v1 restart must not fire a 404-ing request'
    );
    const payload = JSON.parse(out.content[0].text);
    assert.match(payload.error, /only available on the v2 REST API/);
  });

  it('create-pod 501 → clean message, resolves (does not reject)', async () => {
    const { handlers } = harness({ status: 501 });
    // If create-pod re-threw, this await would reject and fail the test.
    const out = (await handlers.get('create-pod')!({ imageName: 'i' })) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(out.content[0].text);
    assert.equal(payload.status, 501);
    assert.match(payload.error, /CPU pods are not yet supported/);
  });

  it('create-pod non-501 errors still REJECT (catch does not over-swallow)', async () => {
    for (const status of [400, 500]) {
      const { handlers } = harness({ status });
      await assert.rejects(
        () => handlers.get('create-pod')!({ imageName: 'i' }),
        (err: unknown) => err instanceof HttpError && err.status === status,
        `status ${status} must propagate`
      );
    }
  });

  it('list-network-volumes → GET <rest>/v1/networkvolumes (path unchanged from v1)', async () => {
    const { handlers, outbound } = harness({ jsonBody: [] });
    await handlers.get('list-network-volumes')!({});
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/networkvolumes');
  });

  it('list-container-registry-auths → GET <rest>/v1/containerregistryauth', async () => {
    const { handlers, outbound } = harness({ jsonBody: [] });
    await handlers.get('list-container-registry-auths')!({});
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/containerregistryauth'
    );
  });

  it('run-endpoint → POST <serverless>/v2/{id}/run (serverless base, not REST)', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('run-endpoint')!({
      endpointId: 'ep_1',
      input: { a: 1 },
    });
    assert.equal(outbound[0].url, 'https://api.runpod.ai/v2/ep_1/run');
    assert.equal(outbound[0].method, 'POST');
  });

  it('update-pod → PATCH <rest>/v1/pods/{id}, body EXCLUDES podId (id-strip)', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('update-pod')!({
      podId: 'pod_1',
      name: 'renamed',
      env: { K: 'V' },
    });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/pods/pod_1');
    assert.equal(outbound[0].method, 'PATCH');
    const body = JSON.parse(outbound[0].body!);
    assert.equal('podId' in body, false, 'podId must be stripped from body');
    assert.deepEqual(body, { name: 'renamed', env: { K: 'V' } });
  });

  it('update-network-volume → PATCH <rest>/v1/networkvolumes/{id}, body excludes id', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('update-network-volume')!({
      networkVolumeId: 'nv_1',
      size: 100,
    });
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/networkvolumes/nv_1'
    );
    assert.equal(outbound[0].method, 'PATCH');
    const body = JSON.parse(outbound[0].body!);
    assert.equal('networkVolumeId' in body, false);
  });

  it('create-template → POST <rest>/v1/templates, body byte-identical', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    const params = { name: 't', imageName: 'img', isServerless: false };
    await handlers.get('create-template')!({ ...params });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/templates');
    assert.equal(outbound[0].method, 'POST');
    assert.equal(outbound[0].body, JSON.stringify(params));
  });

  // --- v1 wire-locks for the rerouted handlers (silent-regression guard) ---
  it('list-templates forwards v1 include* query params', async () => {
    const { handlers, outbound } = harness({ jsonBody: [] });
    await handlers.get('list-templates')!({
      includeRunpodTemplates: true,
      includePublicTemplates: true,
    });
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/templates?includeRunpodTemplates=true&includePublicTemplates=true'
    );
  });

  it('get-template → GET <rest>/v1/templates/{id}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('get-template')!({ templateId: 't_1' });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/templates/t_1');
    assert.equal(outbound[0].method, 'GET');
    assert.equal(outbound[0].body, undefined);
  });

  it('update-template → PATCH <rest>/v1/templates/{id}, body excludes templateId, imageName preserved', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('update-template')!({
      templateId: 't_1',
      imageName: 'img2',
    });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/templates/t_1');
    assert.equal(outbound[0].method, 'PATCH');
    const body = JSON.parse(outbound[0].body!);
    assert.equal('templateId' in body, false);
    assert.equal(body.imageName, 'img2'); // v1 identity keeps imageName
  });

  it('delete-template → DELETE <rest>/v1/templates/{id}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('delete-template')!({ templateId: 't_1' });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/templates/t_1');
    assert.equal(outbound[0].method, 'DELETE');
  });

  it('get-network-volume → GET <rest>/v1/networkvolumes/{id}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('get-network-volume')!({ networkVolumeId: 'nv_1' });
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/networkvolumes/nv_1'
    );
    assert.equal(outbound[0].method, 'GET');
  });

  it('delete-network-volume → DELETE <rest>/v1/networkvolumes/{id}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('delete-network-volume')!({ networkVolumeId: 'nv_1' });
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/networkvolumes/nv_1'
    );
    assert.equal(outbound[0].method, 'DELETE');
  });

  it('get-container-registry-auth → GET <rest>/v1/containerregistryauth/{id}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('get-container-registry-auth')!({
      containerRegistryAuthId: 'cra_1',
    });
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/containerregistryauth/cra_1'
    );
    assert.equal(outbound[0].method, 'GET');
  });

  it('create-container-registry-auth → POST <rest>/v1/containerregistryauth, body byte-identical', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    const params = { name: 'r', username: 'u', password: 'p' };
    await handlers.get('create-container-registry-auth')!({ ...params });
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/containerregistryauth'
    );
    assert.equal(outbound[0].method, 'POST');
    assert.equal(outbound[0].body, JSON.stringify(params));
  });

  it('delete-container-registry-auth → DELETE <rest>/v1/containerregistryauth/{id}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('delete-container-registry-auth')!({
      containerRegistryAuthId: 'cra_1',
    });
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/containerregistryauth/cra_1'
    );
    assert.equal(outbound[0].method, 'DELETE');
  });

  it('create-network-volume → POST <rest>/v1/networkvolumes, body byte-identical', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    const params = { name: 'v', size: 50, dataCenterId: 'EU-RO-1' };
    await handlers.get('create-network-volume')!({ ...params });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/networkvolumes');
    assert.equal(outbound[0].body, JSON.stringify(params));
  });

  it('runsync-endpoint with wait → POST /v2/{id}/runsync?wait=N, wait NOT in body', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('runsync-endpoint')!({
      endpointId: 'ep_2',
      input: { x: 1 },
      wait: 120000,
    });
    assert.equal(
      outbound[0].url,
      'https://api.runpod.ai/v2/ep_2/runsync?wait=120000'
    );
    const body = JSON.parse(outbound[0].body!);
    assert.equal('wait' in body, false, 'wait must not leak into the body');
    assert.equal('endpointId' in body, false);
  });

  it('runsync-endpoint without wait → POST /v2/{id}/runsync (no query)', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('runsync-endpoint')!({
      endpointId: 'ep_3',
      input: { x: 1 },
    });
    assert.equal(outbound[0].url, 'https://api.runpod.ai/v2/ep_3/runsync');
  });

  it('get-job-status → GET <serverless>/v2/{id}/status/{jobId}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('get-job-status')!({ endpointId: 'ep', jobId: 'j1' });
    assert.equal(outbound[0].url, 'https://api.runpod.ai/v2/ep/status/j1');
    assert.equal(outbound[0].method, 'GET');
  });

  it('cancel-job → POST <serverless>/v2/{id}/cancel/{jobId}', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('cancel-job')!({ endpointId: 'ep', jobId: 'j1' });
    assert.equal(outbound[0].url, 'https://api.runpod.ai/v2/ep/cancel/j1');
    assert.equal(outbound[0].method, 'POST');
  });

  it('start-pod → POST <rest>/v1/pods/{id}/start', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    await handlers.get('start-pod')!({ podId: 'pod_s' });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/pods/pod_s/start');
    assert.equal(outbound[0].method, 'POST');
  });
});

// backendFor reads process.env at handler-call time, so set/restore around each.
// MUST await the body inside try/finally — otherwise finally restores the env
// before the awaited handler runs (the body would then read the wrong version).
async function withV2<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.RUNPOD_REST_VERSION;
  process.env.RUNPOD_REST_VERSION = 'v2';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.RUNPOD_REST_VERSION;
    else process.env.RUNPOD_REST_VERSION = prev;
  }
}

describe('pod routing under RUNPOD_REST_VERSION=v2', () => {
  it('list-pods → GET <v2base>/v2/pods (single /v2, no filter query)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { pods: [] } });
      await handlers.get('list-pods')!({ computeType: 'GPU', name: 'x' });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/pods');
      assert.equal(outbound[0].method, 'GET');
    });
  });

  it('list-pods unwraps the v2 {pods:[…]} envelope before capping', async () => {
    await withV2(async () => {
      const items = Array.from({ length: 25 }, (_, i) => ({ id: i }));
      const { handlers } = harness({ jsonBody: { pods: items } });
      const out = await handlers.get('list-pods')!({});
      const env = JSON.parse(
        (out as { content: Array<{ text: string }> }).content[0].text
      );
      assert.equal(env.pagination.total, 25);
      assert.equal(env.items.length, 20);
    });
  });

  it('get-pod → GET <v2base>/v2/pods/{id} with NO query (v1-only filters dropped)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('get-pod')!({
        podId: 'pod_7',
        includeMachine: true,
        includeNetworkVolume: true,
      });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/pods/pod_7');
      assert.equal(outbound[0].method, 'GET');
    });
  });

  it('create-pod → POST <v2base>/v2/pods with the v2-mapped body', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('create-pod')!({
        name: 'p',
        imageName: 'img:1',
        gpuTypeIds: ['A100', 'H100'],
        gpuCount: 2,
        dataCenterIds: ['US-TX-3'],
        volumeInGb: 40,
        volumeMountPath: '/workspace',
      });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/pods');
      assert.equal(outbound[0].method, 'POST');
      const body = JSON.parse(outbound[0].body!);
      assert.equal(body.image, 'img:1');
      assert.equal('imageName' in body, false);
      assert.deepEqual(body.gpu, { id: 'A100', count: 2 });
      assert.deepEqual(body.dataCenterIds, ['US-TX-3']);
      assert.equal('dataCenter' in body, false);
      assert.deepEqual(body.mounts, {
        persistent: { size: 40, path: '/workspace' },
      });
    });
  });

  it('create-pod v2 with a partial volume drops mounts (no size-only mount)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      // gpuTypeIds present so it stays on v2 (a GPU-less create routes to v1).
      await handlers.get('create-pod')!({
        imageName: 'i',
        gpuTypeIds: ['A100'],
        volumeInGb: 40,
      });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/pods');
      const body = JSON.parse(outbound[0].body!);
      assert.equal('mounts' in body, false);
    });
  });

  it('create-pod v2 CPU pod (computeType:"CPU") transparently routes to v1 + flags it', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'pod_cpu' } });
      const out = (await handlers.get('create-pod')!({
        imageName: 'i',
        computeType: 'CPU',
        containerDiskInGb: 10,
      })) as { content: Array<{ text: string }> };
      // routed to v1 (v1 passthrough body), NOT v2
      assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/pods');
      assert.equal(JSON.parse(outbound[0].body!).imageName, 'i');
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload._servedBy, 'v1');
      assert.match(payload._note, /v2 REST API does not support CPU pods/);
    });
  });

  it('create-pod v2 with >1 gpuTypeId → succeeds, warns only the first was used', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'pod_multi' } });
      const out = (await handlers.get('create-pod')!({
        imageName: 'i',
        gpuTypeIds: ['A100', 'H100', 'L40'],
      })) as { content: Array<{ text: string }> };
      // v2 gpu is singular — only the first id reaches the wire.
      assert.deepEqual(JSON.parse(outbound[0].body!).gpu, { id: 'A100' });
      const payload = JSON.parse(out.content[0].text);
      assert.match(payload._warning, /one GPU type/);
      assert.match(payload._warning, /H100/);
      assert.match(payload._warning, /L40/);
    });
  });

  it('create-pod v2 CPU pod whose v1 create fails → clean error reply, not a raw throw', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        status: 400,
        jsonBody: { error: 'bad request' },
      });
      const out = (await handlers.get('create-pod')!({
        imageName: 'i',
        computeType: 'CPU',
        containerDiskInGb: 10,
      })) as { content: Array<{ text: string }> };
      assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/pods');
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, 400);
      assert.equal(payload._servedBy, 'v1');
      assert.match(payload._note, /routed to the v1 API and failed/);
    });
  });

  it('create-pod v2 with gpuCount but NO gpuTypeIds → 400, fires no request (under-specified GPU)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = (await handlers.get('create-pod')!({
        imageName: 'i',
        gpuCount: 1,
      })) as { content: Array<{ text: string }> };
      assert.equal(outbound.length, 0, 'must not fire a request');
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, 400);
      assert.match(payload.error, /A GPU pod needs gpuTypeIds/);
    });
  });

  it('create-pod v2 with no GPU and no computeType → 400, no request (no silent CPU pod)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = (await handlers.get('create-pod')!({ imageName: 'i' })) as {
        content: Array<{ text: string }>;
      };
      assert.equal(
        outbound.length,
        0,
        'absence must not silently create a pod'
      );
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, 400);
      assert.match(payload.error, /No pod type specified/);
    });
  });

  it('create-pod v2 contradiction (gpuTypeIds + computeType:"CPU") → 400, no request', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = (await handlers.get('create-pod')!({
        imageName: 'i',
        gpuTypeIds: ['A100'],
        computeType: 'CPU',
      })) as { content: Array<{ text: string }> };
      assert.equal(outbound.length, 0);
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, 400);
      assert.match(payload.error, /not both/);
    });
  });

  it('per-resource override (RUNPOD_REST_VERSION_PODS=v2) routes a handler to v2 end-to-end', () => {
    const prev = process.env.RUNPOD_REST_VERSION_PODS;
    process.env.RUNPOD_REST_VERSION_PODS = 'v2';
    try {
      const { handlers, outbound } = harness({ jsonBody: { pods: [] } });
      return handlers.get('list-pods')!({}).then(() => {
        assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/pods');
      });
    } finally {
      if (prev === undefined) delete process.env.RUNPOD_REST_VERSION_PODS;
      else process.env.RUNPOD_REST_VERSION_PODS = prev;
    }
  });

  it('stop-pod → POST <v2base>/v2/pods/{id}/action {action:"stop"} (B4)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('stop-pod')!({ podId: 'pod_9' });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/pods/pod_9/action'
      );
      assert.equal(outbound[0].method, 'POST');
      assert.deepEqual(JSON.parse(outbound[0].body!), { action: 'stop' });
    });
  });

  it('start-pod → POST .../v2/pods/{id}/action {action:"start"} (B4)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('start-pod')!({ podId: 'pod_1' });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/pods/pod_1/action'
      );
      assert.deepEqual(JSON.parse(outbound[0].body!), { action: 'start' });
    });
  });

  it('restart-pod → POST .../v2/pods/{id}/action {action:"restart"} (C1/B4)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('restart-pod')!({ podId: 'pod_1' });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/pods/pod_1/action'
      );
      assert.deepEqual(JSON.parse(outbound[0].body!), { action: 'restart' });
    });
  });

  it('update-pod → PATCH .../v2/pods/{id} with mapped body (no podId)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('update-pod')!({ podId: 'pod_2', imageName: 'i2' });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/pods/pod_2');
      assert.equal(outbound[0].method, 'PATCH');
      const body = JSON.parse(outbound[0].body!);
      assert.equal(body.image, 'i2');
      assert.equal('podId' in body, false);
      assert.equal('imageName' in body, false);
    });
  });

  it('delete-pod → DELETE .../v2/pods/{id}', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('delete-pod')!({ podId: 'pod_x' });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/pods/pod_x');
      assert.equal(outbound[0].method, 'DELETE');
    });
  });
});

describe('template / network-volume / registry routing under v2', () => {
  it('list-templates → GET .../v2/templates (no v1 include* query)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { templates: [] } });
      await handlers.get('list-templates')!({ includeRunpodTemplates: true });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/templates');
    });
  });

  it('create-template → POST .../v2/templates with mapped body (serverless + category)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('create-template')!({
        name: 't',
        imageName: 'i',
        isServerless: true,
      });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/templates');
      const body = JSON.parse(outbound[0].body!);
      assert.equal(body.image, 'i');
      assert.equal('imageName' in body, false);
      assert.equal(body.serverless, true);
      assert.equal(body.category, 'NVIDIA');
    });
  });

  it('list-network-volumes → GET .../v2/network-volumes (hyphen)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBody: { networkVolumes: [] },
      });
      await handlers.get('list-network-volumes')!({});
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/network-volumes'
      );
    });
  });

  it('create-network-volume → POST .../v2/network-volumes, dataCenterId→dataCenter', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('create-network-volume')!({
        name: 'v',
        size: 50,
        dataCenterId: 'EU-RO-1',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/network-volumes'
      );
      const body = JSON.parse(outbound[0].body!);
      assert.equal(body.dataCenter, 'EU-RO-1');
      assert.equal('dataCenterId' in body, false);
    });
  });

  it('get-network-volume → GET .../v2/network-volumes/{id}', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('get-network-volume')!({ networkVolumeId: 'nv_1' });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/network-volumes/nv_1'
      );
    });
  });

  it('update-template → PATCH .../v2/templates/{id}, imageName→image (NOT identity), no templateId', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('update-template')!({
        templateId: 't_1',
        imageName: 'img2',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/templates/t_1'
      );
      assert.equal(outbound[0].method, 'PATCH');
      const body = JSON.parse(outbound[0].body!);
      assert.equal(body.image, 'img2'); // v2 mapper maps it
      assert.equal('imageName' in body, false);
      assert.equal('templateId' in body, false);
    });
  });

  it('update-network-volume → PATCH .../v2/network-volumes/{id}, body excludes id', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('update-network-volume')!({
        networkVolumeId: 'nv_1',
        size: 100,
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/network-volumes/nv_1'
      );
      assert.equal(outbound[0].method, 'PATCH');
      assert.equal('networkVolumeId' in JSON.parse(outbound[0].body!), false);
    });
  });

  it('list-container-registry-auths → GET .../v2/registries (rename)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { registries: [] } });
      await handlers.get('list-container-registry-auths')!({});
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/registries');
    });
  });

  it('create-container-registry-auth → POST .../v2/registries (identity body)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const params = { name: 'r', username: 'u', password: 'p' };
      await handlers.get('create-container-registry-auth')!({ ...params });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/registries');
      assert.deepEqual(JSON.parse(outbound[0].body!), params);
    });
  });

  it('delete-container-registry-auth → DELETE .../v2/registries/{id}', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('delete-container-registry-auth')!({
        containerRegistryAuthId: 'cra_1',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/registries/cra_1'
      );
      assert.equal(outbound[0].method, 'DELETE');
    });
  });
});

describe('catalog routing (B5)', () => {
  it('list-gpu-types v2 → GET .../v2/catalog/gpus, unwraps + filters on v2 fields', async () => {
    await withV2(async () => {
      const gpus = [
        {
          id: 'a100',
          name: 'A100',
          memory: 80,
          secure: true,
          community: false,
        },
        {
          id: 'rtx',
          name: 'RTX 4090',
          memory: 24,
          secure: false,
          community: true,
        },
      ];
      const { handlers, outbound } = harness({ jsonBody: { gpus } });
      const out = (await handlers.get('list-gpu-types')!({
        minMemoryGb: 40,
        secureCloudOnly: true,
      })) as { content: Array<{ text: string }> };
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/catalog/gpus'
      );
      const payload = JSON.parse(out.content[0].text).items;
      assert.equal(payload.length, 1);
      assert.equal(payload[0].id, 'a100');
    });
  });

  it('list-gpu-types v2 communityCloudOnly filters on g.community', async () => {
    await withV2(async () => {
      const gpus = [
        { id: 'a', name: 'A', community: false },
        { id: 'b', name: 'B', community: true },
      ];
      const { handlers } = harness({ jsonBody: { gpus } });
      const out = (await handlers.get('list-gpu-types')!({
        communityCloudOnly: true,
      })) as { content: Array<{ text: string }> };
      const payload = JSON.parse(out.content[0].text).items;
      assert.deepEqual(
        payload.map((g: { id: string }) => g.id),
        ['b']
      );
    });
  });

  it('list-gpu-types v2 includeUnavailable is a no-op (does not filter)', async () => {
    await withV2(async () => {
      const gpus = [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ];
      const { handlers } = harness({ jsonBody: { gpus } });
      const out = (await handlers.get('list-gpu-types')!({
        includeUnavailable: false,
      })) as { content: Array<{ text: string }> };
      assert.equal(JSON.parse(out.content[0].text).items.length, 2);
    });
  });

  it('list-gpu-types v2 no filters → returns all (unwrap only)', async () => {
    await withV2(async () => {
      const gpus = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      const { handlers } = harness({ jsonBody: { gpus } });
      const out = (await handlers.get('list-gpu-types')!({})) as {
        content: Array<{ text: string }>;
      };
      assert.equal(JSON.parse(out.content[0].text).items.length, 3);
    });
  });

  it('list-gpu-types v2 searchTerm matches id/name', async () => {
    await withV2(async () => {
      const gpus = [
        { id: 'a100', name: 'A100', memory: 80 },
        { id: 'rtx', name: 'RTX 4090', memory: 24 },
      ];
      const { handlers } = harness({ jsonBody: { gpus } });
      const out = (await handlers.get('list-gpu-types')!({
        searchTerm: '4090',
      })) as { content: Array<{ text: string }> };
      const payload = JSON.parse(out.content[0].text).items;
      assert.equal(payload.length, 1);
      assert.equal(payload[0].id, 'rtx');
    });
  });

  it('list-data-centers v2 → GET .../v2/catalog/datacenters, region filter on enum', async () => {
    await withV2(async () => {
      const dataCenters = [
        { id: 'US-TX-3', region: 'NORTH_AMERICA' },
        { id: 'EU-RO-1', region: 'EUROPE' },
      ];
      const { handlers, outbound } = harness({ jsonBody: { dataCenters } });
      const out = (await handlers.get('list-data-centers')!({
        region: 'europe',
      })) as { content: Array<{ text: string }> };
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/catalog/datacenters'
      );
      const payload = JSON.parse(out.content[0].text).items;
      assert.equal(payload.length, 1);
      assert.equal(payload[0].id, 'EU-RO-1');
    });
  });

  it('list-cpu-types: v1 → clean "v2 only" message (no request); v2 → GET .../v2/catalog/cpus', async () => {
    // v1
    const v1 = harness({ jsonBody: {} });
    assert.ok(v1.handlers.has('list-cpu-types'));
    const v1out = (await v1.handlers.get('list-cpu-types')!({})) as {
      content: Array<{ text: string }>;
    };
    assert.equal(v1.outbound.length, 0);
    assert.match(
      JSON.parse(v1out.content[0].text).error,
      /only available on the v2/
    );
    // v2
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBody: { cpus: [{ id: 'cpu5c' }] },
      });
      const out = (await handlers.get('list-cpu-types')!({})) as {
        content: Array<{ text: string }>;
      };
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/catalog/cpus'
      );
      assert.deepEqual(JSON.parse(out.content[0].text).items, [
        { id: 'cpu5c' },
      ]);
    });
  });

  it('get-gpu-type: v1 → clean message; v2 → GET .../v2/catalog/gpus/{id}', async () => {
    const v1 = harness({ jsonBody: {} });
    const v1out = (await v1.handlers.get('get-gpu-type')!({
      gpuTypeId: 'a100',
    })) as { content: Array<{ text: string }> };
    assert.equal(v1.outbound.length, 0);
    assert.match(
      JSON.parse(v1out.content[0].text).error,
      /only available on the v2/
    );
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBody: { id: 'a100', memory: 80 },
      });
      const out = (await handlers.get('get-gpu-type')!({
        gpuTypeId: 'a100',
      })) as { content: Array<{ text: string }> };
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/catalog/gpus/a100'
      );
      // raw passthrough (no unwrap) — body preserved
      assert.deepEqual(JSON.parse(out.content[0].text), {
        id: 'a100',
        memory: 80,
      });
    });
  });

  it('list-gpu-types v2 caps to limit + returns a working pagination cursor', async () => {
    await withV2(async () => {
      const gpus = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      const { handlers } = harness({ jsonBody: { gpus } });
      const page1 = JSON.parse(
        (
          (await handlers.get('list-gpu-types')!({ limit: 2 })) as {
            content: Array<{ text: string }>;
          }
        ).content[0].text
      );
      assert.equal(page1.items.length, 2);
      assert.equal(page1.pagination.total, 3);
      assert.equal(page1.pagination.truncated, true);
      assert.ok(page1.pagination.nextCursor);

      const page2 = JSON.parse(
        (
          (await handlers.get('list-gpu-types')!({
            limit: 2,
            cursor: page1.pagination.nextCursor,
          })) as { content: Array<{ text: string }> }
        ).content[0].text
      );
      assert.deepEqual(
        page2.items.map((g: { id: string }) => g.id),
        ['c']
      );
      assert.equal(page2.pagination.truncated, false);
    });
  });
});

describe('stream-job poll loop (sequenced responses)', () => {
  it('polls /v2/{id}/stream/{jobId} until a terminal status', async () => {
    const { handlers, outbound } = harness({
      jsonBodies: [
        { status: 'IN_PROGRESS', stream: [{ output: 1 }] },
        { status: 'COMPLETED', stream: [{ output: 2 }] },
      ],
    });
    const out = await handlers.get('stream-job')!({
      endpointId: 'ep',
      jobId: 'jX',
    });
    // every poll hits the stream URL
    for (const rec of outbound) {
      assert.equal(rec.url, 'https://api.runpod.ai/v2/ep/stream/jX');
      assert.equal(rec.method, 'GET');
    }
    assert.ok(outbound.length >= 2, 'should poll until terminal status');
    assert.ok(out, 'returns a result');
  });
});

describe('list tools: unwrap + cap (v1 bare array)', () => {
  function parse(result: unknown): {
    items: unknown[];
    pagination: { total: number; returned: number; truncated: boolean };
  } {
    const r = result as { content: Array<{ text: string }> };
    return JSON.parse(r.content[0].text);
  }

  it('caps a 25-item v1 list to the default 20 and reports truncation', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}` }));
    const { handlers } = harness({ jsonBody: items });
    const out = await handlers.get('list-pods')!({});
    const env = parse(out);
    assert.equal(env.pagination.total, 25);
    assert.equal(env.pagination.returned, 20);
    assert.equal(env.pagination.truncated, true);
    assert.equal(env.items.length, 20);
  });

  it('respects an explicit limit', async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const { handlers } = harness({ jsonBody: items });
    const out = await handlers.get('list-pods')!({ limit: 3 });
    assert.equal(parse(out).items.length, 3);
  });
});

// ============== NEW v2-only tools (tags, billing, workers, catalog gets) ==============
// Each is v2-only: on v1 it must return a clean 501 WITHOUT firing a request;
// on v2 it hits the documented path. Wire-locks mirror the spec endpoints.
function parseText(out: unknown): Record<string, unknown> {
  return JSON.parse(
    (out as { content: Array<{ text: string }> }).content[0].text
  );
}

describe('tags tools (v2-only)', () => {
  it('list-tags: v1 → 501 no request; v2 → GET /v2/tags, includeResources adds ?include=resources', async () => {
    const v1 = harness({ jsonBody: {} });
    const v1out = await v1.handlers.get('list-tags')!({});
    assert.equal(v1.outbound.length, 0);
    assert.equal(parseText(v1out).status, 501);

    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBody: { tags: [{ id: 't1', key: 'k', value: 'v' }] },
      });
      const out = await handlers.get('list-tags')!({ includeResources: true });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/tags?include=resources'
      );
      assert.deepEqual(parseText(out).items, [
        { id: 't1', key: 'k', value: 'v' },
      ]);
    });
  });

  it('get-tag → GET /v2/tags/{id} (no include when not requested)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 't1' } });
      await handlers.get('get-tag')!({ tagId: 't1' });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/tags/t1');
      assert.equal(outbound[0].method, 'GET');
    });
  });

  it('create-tag → POST /v2/tags with {key,value,resources}', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('create-tag')!({
        key: 'project',
        value: 'gpt',
        resources: [{ id: 'pod_1', type: 'POD' }],
      });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/tags');
      assert.equal(outbound[0].method, 'POST');
      assert.deepEqual(JSON.parse(outbound[0].body!), {
        key: 'project',
        value: 'gpt',
        resources: [{ id: 'pod_1', type: 'POD' }],
      });
    });
  });

  it('update-tag → PATCH /v2/tags/{id}, body excludes tagId', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('update-tag')!({ tagId: 't1', value: 'new' });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/tags/t1');
      assert.equal(outbound[0].method, 'PATCH');
      const body = JSON.parse(outbound[0].body!);
      assert.equal('tagId' in body, false);
      assert.deepEqual(body, { value: 'new' });
    });
  });

  it('delete-tag → DELETE /v2/tags/{id}', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('delete-tag')!({ tagId: 't1' });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/tags/t1');
      assert.equal(outbound[0].method, 'DELETE');
    });
  });

  it('attach-tag → PUT /v2/tags/{id}/resources/{type}/{id}', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('attach-tag')!({
        tagId: 't1',
        resourceType: 'SERVERLESS_ENDPOINT',
        resourceId: 'ep_9',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/tags/t1/resources/SERVERLESS_ENDPOINT/ep_9'
      );
      assert.equal(outbound[0].method, 'PUT');
    });
  });

  it('detach-tag → DELETE /v2/tags/{id}/resources/{type}/{id}', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('detach-tag')!({
        tagId: 't1',
        resourceType: 'POD',
        resourceId: 'pod_2',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/tags/t1/resources/POD/pod_2'
      );
      assert.equal(outbound[0].method, 'DELETE');
    });
  });

  it('attach-tag URL-encodes free-text tagId/resourceId (not the enum resourceType)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('attach-tag')!({
        tagId: 'a/b?c',
        resourceType: 'POD',
        resourceId: 'p#1',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/tags/a%2Fb%3Fc/resources/POD/p%231'
      );
    });
  });
});

describe('billing tool (v2-only)', () => {
  it('get-billing: v1 → 501 no request', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    const out = await handlers.get('get-billing')!({});
    assert.equal(outbound.length, 0);
    assert.equal(parseText(out).status, 501);
  });

  it('get-billing v2 scope=all → GET /v2/billing, caps records, preserves metadata', async () => {
    await withV2(async () => {
      const records = Array.from({ length: 25 }, (_, i) => ({ cost: i }));
      const { handlers, outbound } = harness({
        jsonBody: { records, metadata: { total: 123 } },
      });
      const out = await handlers.get('get-billing')!({});
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/billing');
      const env = parseText(out);
      assert.equal((env.pagination as { total: number }).total, 25);
      assert.equal((env.items as unknown[]).length, 20);
      assert.deepEqual(env.metadata, { total: 123 });
    });
  });

  it('get-billing drops lastN when a startTime/endTime window is supplied (mutually exclusive)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBody: { records: [], metadata: {} },
      });
      await handlers.get('get-billing')!({
        startTime: '2026-05-01T00:00:00Z',
        lastN: 5,
      });
      const url = new URL(outbound[0].url);
      assert.equal(url.searchParams.get('startTime'), '2026-05-01T00:00:00Z');
      assert.equal(url.searchParams.has('lastN'), false);
    });
  });

  it('get-billing v2 scope=pods + lastN → GET /v2/billing/pods?lastN=5', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBody: { records: [], metadata: {} },
      });
      await handlers.get('get-billing')!({ scope: 'pods', lastN: 5 });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/billing/pods?lastN=5'
      );
    });
  });
});

describe('list-endpoint-workers (v2-only)', () => {
  it('v1 → 501 no request', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    const out = await handlers.get('list-endpoint-workers')!({
      endpointId: 'ep_1',
    });
    assert.equal(outbound.length, 0);
    assert.equal(parseText(out).status, 501);
  });

  it('v2 → GET /v2/serverless/{id}/workers, caps workers, preserves summary', async () => {
    await withV2(async () => {
      const workers = Array.from({ length: 3 }, (_, i) => ({ id: `w${i}` }));
      const { handlers, outbound } = harness({
        jsonBody: { workers, summary: { ready: 3 }, endpointVersion: 4 },
      });
      const out = await handlers.get('list-endpoint-workers')!({
        endpointId: 'ep_1',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/serverless/ep_1/workers'
      );
      const env = parseText(out);
      assert.equal((env.items as unknown[]).length, 3);
      assert.deepEqual(env.summary, { ready: 3 });
      assert.equal(env.endpointVersion, 4);
    });
  });
});

describe('catalog gets (v2-only)', () => {
  it('get-cpu-type: v1 → 501; v2 → GET /v2/catalog/cpus/{id}', async () => {
    const v1 = harness({ jsonBody: {} });
    const v1out = await v1.handlers.get('get-cpu-type')!({
      cpuTypeId: 'cpu5c',
    });
    assert.equal(v1.outbound.length, 0);
    assert.equal(parseText(v1out).status, 501);
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'cpu5c' } });
      await handlers.get('get-cpu-type')!({ cpuTypeId: 'cpu5c' });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/catalog/cpus/cpu5c'
      );
    });
  });

  it('get-data-center: v1 → 501; v2 → GET /v2/catalog/datacenters/{id}', async () => {
    const v1 = harness({ jsonBody: {} });
    const v1out = await v1.handlers.get('get-data-center')!({
      dataCenterId: 'EU-RO-1',
    });
    assert.equal(v1.outbound.length, 0);
    assert.equal(parseText(v1out).status, 501);
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'EU-RO-1' } });
      await handlers.get('get-data-center')!({ dataCenterId: 'EU-RO-1' });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/catalog/datacenters/EU-RO-1'
      );
    });
  });
});

// Uniform guard: EVERY v2-only tool must, on v1, return status 501 and fire NO
// outbound request (a stray v1 call would 404/500). Covers the per-tool 501
// path that the individual wire-locks above only spot-check.
describe('all v2-only tools: v1 → 501 with no request', () => {
  const V2_ONLY_CALLS: Array<[string, Record<string, unknown>]> = [
    ['list-tags', {}],
    ['get-tag', { tagId: 't1' }],
    ['create-tag', { key: 'k', value: 'v' }],
    ['update-tag', { tagId: 't1', value: 'v' }],
    ['delete-tag', { tagId: 't1' }],
    ['attach-tag', { tagId: 't1', resourceType: 'POD', resourceId: 'p1' }],
    ['detach-tag', { tagId: 't1', resourceType: 'POD', resourceId: 'p1' }],
    ['get-billing', {}],
    ['list-endpoint-workers', { endpointId: 'ep_1' }],
    ['get-cpu-type', { cpuTypeId: 'cpu5c' }],
    ['get-data-center', { dataCenterId: 'EU-RO-1' }],
    ['list-cpu-types', {}],
    ['get-gpu-type', { gpuTypeId: 'a100' }],
    ['restart-pod', { podId: 'pod_1' }],
  ];

  for (const [tool, args] of V2_ONLY_CALLS) {
    it(`${tool} → 501, no request on v1`, async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      assert.ok(handlers.has(tool), `${tool} must be registered`);
      const out = await handlers.get(tool)!(args);
      assert.equal(outbound.length, 0, `${tool} must not fire a v1 request`);
      assert.equal(parseText(out).status, 501, `${tool} must return 501`);
    });
  }
});
