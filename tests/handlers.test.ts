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
  // Fake SSE reader for stream-pod-logs (the real one uses node-fetch directly,
  // bypassing the injected fetch). Records its calls and returns canned text.
  streamSse?: (
    url: string,
    o: { maxWaitMs: number; maxBytes: number }
  ) => Promise<{ raw: string; truncated: boolean }>;
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

  registerTools(fakeServer, { apiKey: 'rpa_test', transport: 'stdio' }, {
    fetch: fakeFetch as Parameters<typeof registerTools>[2]['fetch'],
    ...(opts?.streamSse ? { streamSse: opts.streamSse } : {}),
  } as Parameters<typeof registerTools>[2]);

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

  it('create-pod 501 → clean {error,status} reply, resolves (does not reject)', async () => {
    const { handlers } = harness({ status: 501 });
    // If create-pod re-threw, this await would reject and fail the test.
    const out = (await handlers.get('create-pod')!({ imageName: 'i' })) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(out.content[0].text);
    assert.equal(payload.status, 501);
    // Surfaces the API's own message, not a CPU-support mislabel.
    assert.match(payload.error, /Runpod API Error/);
    assert.doesNotMatch(payload.error, /CPU pods are not yet supported/);
  });

  it('create-pod non-501 HTTP errors surface as a clean {error, status} reply (no raw throw)', async () => {
    // A 400 (capacity/validation) or 5xx must resolve to a readable reply the
    // model can act on, not reject out of the tool.
    for (const status of [400, 500]) {
      const { handlers } = harness({ status });
      const out = (await handlers.get('create-pod')!({ imageName: 'i' })) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, status, `status ${status} must surface`);
      assert.match(payload.error, /Runpod API Error/);
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

  // ── template-based deploy (create-pod with templateId, v2) ──────────────────
  // v2 CreatePodRequest has no templateId, so create-pod fetches the template and
  // spreads its container config into the pod body. First outbound call is the
  // template GET, second is the pod POST.
  const TEMPLATE_JSON = {
    id: 'tpl_1',
    name: 'pytorch-template',
    image: 'runpod/pytorch:2.8.0',
    args: 'python -u handler.py',
    disk: 40,
    ports: ['8888/http'],
    env: { FOO: 'bar' },
    registry: 'cra_9',
    serverless: false,
    category: 'NVIDIA',
  };

  it('create-pod v2 with templateId fetches the template and merges its config into the POST', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBodies: [TEMPLATE_JSON, { id: 'pod_new' }],
      });
      await handlers.get('create-pod')!({
        templateId: 'tpl_1',
        gpuTypeIds: ['A100'],
      });
      assert.equal(outbound.length, 2);
      // 1) template GET
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/templates/tpl_1'
      );
      assert.equal(outbound[0].method, 'GET');
      // 2) pod POST with the template's container config folded in
      assert.equal(outbound[1].url, 'https://v2-rest.runpod.io/v2/pods');
      assert.equal(outbound[1].method, 'POST');
      const body = JSON.parse(outbound[1].body!);
      assert.equal(body.image, 'runpod/pytorch:2.8.0');
      assert.equal(body.args, 'python -u handler.py'); // start command survives
      assert.equal(body.disk, 40);
      assert.deepEqual(body.ports, ['8888/http']);
      assert.deepEqual(body.env, { FOO: 'bar' });
      assert.equal(body.registry, 'cra_9'); // registry inherited so private images pull
      assert.equal(body.name, 'pytorch-template'); // pod-name default from template
      assert.deepEqual(body.gpu, { id: 'A100' }); // caller-supplied compute
      // template-only fields never reach the pod body
      assert.equal('serverless' in body, false);
      assert.equal('category' in body, false);
      assert.equal('id' in body, false);
    });
  });

  it('create-pod v2 explicit params override the template defaults', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBodies: [TEMPLATE_JSON, { id: 'pod_new' }],
      });
      await handlers.get('create-pod')!({
        templateId: 'tpl_1',
        gpuTypeIds: ['A100'],
        name: 'my-pod',
        imageName: 'my/override:latest',
        containerDiskInGb: 100,
        containerRegistryAuthId: 'cra_override',
      });
      const body = JSON.parse(outbound[1].body!);
      assert.equal(body.image, 'my/override:latest'); // caller image wins
      assert.equal(body.name, 'my-pod'); // caller name wins
      assert.equal(body.disk, 100); // caller disk wins
      assert.equal(body.registry, 'cra_override'); // caller registry overrides template's cra_9
      assert.equal(body.args, 'python -u handler.py'); // untouched template field stays
    });
  });

  it('create-pod v2 empty containerRegistryAuthId clears the template registry (registry:null)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBodies: [TEMPLATE_JSON, { id: 'pod_new' }],
      });
      await handlers.get('create-pod')!({
        templateId: 'tpl_1',
        gpuTypeIds: ['A100'],
        containerRegistryAuthId: '',
      });
      const body = JSON.parse(outbound[1].body!);
      // opt-out: explicit null wins over the template's cra_9 (v2 accepts null)
      assert.equal(body.registry, null);
    });
  });

  it('create-pod v2 with a bad templateId surfaces the template load error, fires no pod POST', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ status: 404, jsonBody: {} });
      const out = (await handlers.get('create-pod')!({
        templateId: 'nope',
        gpuTypeIds: ['A100'],
      })) as { content: Array<{ text: string }> };
      assert.equal(outbound.length, 1); // only the failed template GET
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, 404);
      assert.match(payload.error, /Failed to load template nope/);
    });
  });

  it('create-pod on v1 with templateId → 501, fires no request', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    const out = (await handlers.get('create-pod')!({
      templateId: 'tpl_1',
      gpuTypeIds: ['A100'],
    })) as { content: Array<{ text: string }> };
    assert.equal(outbound.length, 0);
    const payload = JSON.parse(out.content[0].text);
    assert.equal(payload.status, 501);
    assert.match(payload.error, /only supported on the v2 REST API/);
  });

  it('create-pod v2 with neither imageName nor templateId → 400, no request', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = (await handlers.get('create-pod')!({
        gpuTypeIds: ['A100'],
      })) as { content: Array<{ text: string }> };
      assert.equal(outbound.length, 0);
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, 400);
      assert.match(payload.error, /Provide imageName, or templateId/);
    });
  });

  it('create-pod v2 CPU + templateId → 400 (template deploy is GPU-only for now)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = (await handlers.get('create-pod')!({
        templateId: 'tpl_1',
        computeType: 'CPU',
      })) as { content: Array<{ text: string }> };
      assert.equal(outbound.length, 0);
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, 400);
      assert.match(payload.error, /only for GPU pods/);
    });
  });

  it('create-pod surfaces a 400 (e.g. "no instances available") as a clean reply, not a throw', async () => {
    await withV2(async () => {
      const { handlers } = harness({ status: 400, jsonBody: {} });
      // Must RESOLVE (not reject) so the model sees a readable error rather than
      // a raw thrown stack.
      const out = (await handlers.get('create-pod')!({
        imageName: 'i',
        gpuTypeIds: ['A100'],
      })) as { content: Array<{ text: string }> };
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, 400);
      assert.match(payload.error, /Runpod API Error/);
    });
  });

  it('create-pod does NOT mislabel a GPU-create 501 as a CPU-support issue', async () => {
    // CPU pods route to v1 before the v2 POST, so a 501 on a GPU create here is
    // an unimplemented-path error, not "CPU not supported". Surface the API's own
    // message rather than the misleading CPU hint.
    await withV2(async () => {
      const { handlers } = harness({ status: 501, jsonBody: {} });
      const out = (await handlers.get('create-pod')!({
        imageName: 'i',
        gpuTypeIds: ['A100'],
      })) as { content: Array<{ text: string }> };
      const payload = JSON.parse(out.content[0].text);
      assert.equal(payload.status, 501);
      assert.doesNotMatch(payload.error, /CPU pods are not yet supported/);
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

  it('create-template → POST .../v2/templates with mapped body, no forced category', async () => {
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
      // `category` is optional on v2 now (server defaults it to NVIDIA), so we
      // no longer send a value the caller never asked for.
      assert.equal('category' in body, false);
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

  // ECR delegations hang off the registries collection, so their URLs are built
  // from the same base + list path — these lock that they land on
  // /v2/registries/delegations and not, say, /v2/delegations.
  it('list-registry-delegations → GET .../v2/registries/delegations, unwraps {delegations:[…]}', async () => {
    await withV2(async () => {
      const rows = Array.from({ length: 3 }, (_, i) => ({ id: `deleg_${i}` }));
      const { handlers, outbound } = harness({
        jsonBody: { delegations: rows },
      });
      const out = await handlers.get('list-registry-delegations')!({});
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/registries/delegations'
      );
      assert.equal(outbound[0].method, 'GET');
      assert.equal((parseText(out).items as unknown[]).length, 3);
    });
  });

  it('list-registry-delegations tolerates a missing/odd envelope (no throw)', async () => {
    await withV2(async () => {
      const { handlers } = harness({ jsonBody: { unexpected: 'shape' } });
      const out = await handlers.get('list-registry-delegations')!({});
      assert.deepEqual(parseText(out).items, []);
    });
  });

  it('create-registry-delegation → POST .../v2/registries/delegations, ARN body', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'deleg_1' } });
      await handlers.get('create-registry-delegation')!({
        resource: 'arn:aws:ecr:us-east-2:123456789012:repository/org/img',
        name: 'my-deleg',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/registries/delegations'
      );
      assert.equal(outbound[0].method, 'POST');
      assert.deepEqual(JSON.parse(outbound[0].body!), {
        resource: 'arn:aws:ecr:us-east-2:123456789012:repository/org/img',
        name: 'my-deleg',
      });
    });
  });

  it('create-registry-delegation omits `name` when unset (additionalProperties:false)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('create-registry-delegation')!({ resource: 'arn:x' });
      const body = JSON.parse(outbound[0].body!);
      assert.deepEqual(body, { resource: 'arn:x' });
      assert.equal('name' in body, false);
    });
  });

  it('delete-registry-delegation → DELETE .../v2/registries/delegations/{id}, id encoded', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('delete-registry-delegation')!({
        delegationId: 'deleg/1',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/registries/delegations/deleg%2F1'
      );
      assert.equal(outbound[0].method, 'DELETE');
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
        'https://v2-rest.runpod.io/v2/catalog/gpus?include=AVAILABILITY'
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

  it('list-gpu-types v2 shows all GPUs by default (nothing hidden), sorted highest-stock-first; includeUnavailable:false hides out-of-stock', async () => {
    await withV2(async () => {
      const gpus = [
        { id: 'b', name: 'B', availability: 'NONE' },
        { id: 'a', name: 'A', availability: 'MEDIUM' },
      ];
      // default: full catalog, nothing hidden, highest stock first, per-DC breakdown stripped
      const def = (await harness({ jsonBody: { gpus } }).handlers.get(
        'list-gpu-types'
      )!({})) as { content: Array<{ text: string }> };
      const items = JSON.parse(def.content[0].text).items;
      assert.deepEqual(
        items.map((g: { id: string }) => g.id),
        ['a', 'b']
      );
      assert.equal('dataCenters' in items[0], false);
      // includeUnavailable:false → opt in to hiding out-of-stock
      const only = (await harness({ jsonBody: { gpus } }).handlers.get(
        'list-gpu-types'
      )!({ includeUnavailable: false })) as {
        content: Array<{ text: string }>;
      };
      assert.deepEqual(
        JSON.parse(only.content[0].text).items.map((g: { id: string }) => g.id),
        ['a']
      );
    });
  });

  it('list-gpu-types v2 includeAvailability:false skips the stock lookup (no query param)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBody: { gpus: [{ id: 'a' }, { id: 'b' }] },
      });
      const out = (await handlers.get('list-gpu-types')!({
        includeAvailability: false,
      })) as { content: Array<{ text: string }> };
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/catalog/gpus'
      );
      // no availability data → nothing filtered out
      assert.equal(JSON.parse(out.content[0].text).items.length, 2);
    });
  });

  it('list-gpu-types v2 leaves GPUs whose availability is unpopulated (never over-filters)', async () => {
    await withV2(async () => {
      const gpus = [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ];
      const { handlers } = harness({ jsonBody: { gpus } });
      const out = (await handlers.get('list-gpu-types')!({})) as {
        content: Array<{ text: string }>;
      };
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

  it('list-gpu-types v2 drops the "unknown" sentinel GPU (parity with v1)', async () => {
    await withV2(async () => {
      const gpus = [
        { id: 'a', name: 'A', availability: 'HIGH' },
        { id: 'unknown', name: 'unknown', availability: 'NONE' },
      ];
      const { handlers } = harness({ jsonBody: { gpus } });
      const out = (await handlers.get('list-gpu-types')!({})) as {
        content: Array<{ text: string }>;
      };
      assert.deepEqual(
        JSON.parse(out.content[0].text).items.map((g: { id: string }) => g.id),
        ['a']
      );
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
      // availability is requested by default
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/catalog/gpus/a100?include=AVAILABILITY'
      );
      // raw passthrough (no unwrap) — body preserved
      assert.deepEqual(JSON.parse(out.content[0].text), {
        id: 'a100',
        memory: 80,
      });
    });
  });

  it('get-gpu-type v2 URL-encodes ids with spaces and can opt out of availability', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'x' } });
      await handlers.get('get-gpu-type')!({
        gpuTypeId: 'NVIDIA GeForce RTX 4090',
        includeAvailability: false,
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/catalog/gpus/NVIDIA%20GeForce%20RTX%204090'
      );
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

// ====== NEW v2-only tools (delegations, billing, workers, catalog gets) ======
// Each is v2-only: on v1 it must return a clean 501 WITHOUT firing a request;
// on v2 it hits the documented path. Wire-locks mirror the spec endpoints.
function parseText(out: unknown): Record<string, unknown> {
  return JSON.parse(
    (out as { content: Array<{ text: string }> }).content[0].text
  );
}

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
    ['list-registry-delegations', {}],
    [
      'create-registry-delegation',
      { resource: 'arn:aws:ecr:us-east-2:1:repository/r' },
    ],
    ['delete-registry-delegation', { delegationId: 'deleg_1' }],
    ['get-billing', {}],
    ['list-endpoint-workers', { endpointId: 'ep_1' }],
    ['stream-pod-logs', { podId: 'pod_1' }],
    ['stream-worker-logs', { endpointId: 'ep_1', workerId: 'w_1' }],
    ['list-endpoint-releases', { endpointId: 'ep_1' }],
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

// ============== Endpoint CRUD routing (v1 templateId vs v2 inline config) =====
describe('endpoint routing under RUNPOD_REST_VERSION=v2', () => {
  it('list-endpoints → GET <v2>/v2/serverless, unwraps {endpoints:[…]}, no v1 query', async () => {
    await withV2(async () => {
      const eps = Array.from({ length: 2 }, (_, i) => ({ id: `ep${i}` }));
      const { handlers, outbound } = harness({ jsonBody: { endpoints: eps } });
      const out = await handlers.get('list-endpoints')!({
        includeWorkers: true, // v1-only param, must be dropped on v2
      });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/serverless');
      assert.equal(outbound[0].method, 'GET');
      assert.equal((parseText(out).items as unknown[]).length, 2);
    });
  });

  it('get-endpoint → GET <v2>/v2/serverless/{id}, no v1 query params', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'ep_1' } });
      await handlers.get('get-endpoint')!({
        endpointId: 'ep_1',
        includeTemplate: true,
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/serverless/ep_1'
      );
    });
  });

  it('create-endpoint → POST <v2>/v2/serverless with nested gpu/workers/scaling body', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'ep_new' } });
      await handlers.get('create-endpoint')!({
        name: 'e',
        imageName: 'img:2',
        gpuPoolIds: ['AMPERE_80'],
        gpuCount: 1,
        workersMin: 0,
        workersMax: 3,
        scalerType: 'QUEUE_DELAY',
        scalerValue: 4,
        idleTimeout: 5,
        containerDiskInGb: 20,
        env: { K: 'V' },
        networkVolumeIds: ['nv_1'],
        executionTimeoutMs: 600000,
        flashboot: 'FLASHBOOT',
        containerRegistryAuthId: 'cra_1',
      });
      assert.equal(outbound[0].url, 'https://v2-rest.runpod.io/v2/serverless');
      assert.equal(outbound[0].method, 'POST');
      const body = JSON.parse(outbound[0].body!);
      assert.equal(body.name, 'e');
      assert.equal(body.image, 'img:2');
      assert.equal('imageName' in body, false);
      assert.deepEqual(body.gpu, { pools: ['AMPERE_80'], count: 1 });
      assert.deepEqual(body.workers, { min: 0, max: 3 });
      assert.deepEqual(body.scaling, {
        type: 'QUEUE_DELAY',
        value: 4,
        idleTimeout: 5,
      });
      assert.equal(body.disk, 20);
      assert.deepEqual(body.env, { K: 'V' });
      assert.deepEqual(body.networkVolumes, ['nv_1']);
      assert.equal('networkVolumeIds' in body, false);
      assert.equal(body.timeout, 600000);
      assert.equal(body.flashboot, 'FLASHBOOT');
      assert.equal(body.registry, 'cra_1');
      assert.equal('mounts' in body, false); // endpoints don't carry pod mounts
    });
  });

  it('create-endpoint v2 missing name → clean 400, no request', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = await handlers.get('create-endpoint')!({
        imageName: 'img:2',
        gpuPoolIds: ['AMPERE_80'],
      });
      assert.equal(outbound.length, 0);
      assert.equal(parseText(out).status, 400);
      assert.match(parseText(out).error as string, /name/);
    });
  });

  it('create-endpoint v2 missing imageName → clean 400, no request', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = await handlers.get('create-endpoint')!({
        name: 'e',
        gpuPoolIds: ['AMPERE_80'],
      });
      assert.equal(outbound.length, 0);
      assert.equal(parseText(out).status, 400);
      assert.match(parseText(out).error as string, /imageName/);
    });
  });

  it('create-endpoint v2 missing gpuPoolIds → clean 400, no request', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = await handlers.get('create-endpoint')!({
        name: 'e',
        imageName: 'img:2',
      });
      assert.equal(outbound.length, 0);
      assert.equal(parseText(out).status, 400);
      assert.match(parseText(out).error as string, /gpuPoolIds/);
    });
  });

  it('update-endpoint → PATCH <v2>/v2/serverless/{id} with mapped body, id not in body', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'ep_1' } });
      await handlers.get('update-endpoint')!({
        endpointId: 'ep_1',
        workersMax: 5,
        imageName: 'img:3',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/serverless/ep_1'
      );
      assert.equal(outbound[0].method, 'PATCH');
      const body = JSON.parse(outbound[0].body!);
      assert.deepEqual(body.workers, { max: 5 });
      assert.equal(body.image, 'img:3');
      assert.equal('endpointId' in body, false);
    });
  });

  it('delete-endpoint → DELETE <v2>/v2/serverless/{id}', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('delete-endpoint')!({ endpointId: 'ep_1' });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/serverless/ep_1'
      );
      assert.equal(outbound[0].method, 'DELETE');
    });
  });
});

describe('endpoint routing under v1 (templateId model preserved)', () => {
  it('create-endpoint v1 → POST <rest>/v1/endpoints, sends only v1 fields (v2-only dropped)', async () => {
    const { handlers, outbound } = harness({ jsonBody: { id: 'ep_1' } });
    await handlers.get('create-endpoint')!({
      name: 'e',
      templateId: 'tpl_1',
      workersMax: 3,
      // v2-only fields a confused caller might also pass — must NOT reach v1:
      imageName: 'img:2',
      gpuPoolIds: ['AMPERE_80'],
      flashboot: 'FLASHBOOT',
      networkVolumeIds: ['nv_1'],
      executionTimeoutMs: 600000,
    });
    assert.equal(outbound[0].url, 'https://rest.runpod.io/v1/endpoints');
    assert.equal(outbound[0].method, 'POST');
    const body = JSON.parse(outbound[0].body!);
    assert.equal(body.templateId, 'tpl_1');
    assert.equal(body.name, 'e');
    assert.equal(body.workersMax, 3);
    assert.equal('gpu' in body, false); // no v2 nesting on v1
    for (const k of [
      'imageName',
      'gpuPoolIds',
      'flashboot',
      'networkVolumeIds',
      'executionTimeoutMs',
    ]) {
      assert.equal(k in body, false, `v2-only field ${k} must not reach v1`);
    }
  });

  it('create-endpoint v1 missing templateId → clean 400, no request', async () => {
    const { handlers, outbound } = harness({ jsonBody: {} });
    const out = await handlers.get('create-endpoint')!({ name: 'e' });
    assert.equal(outbound.length, 0);
    assert.equal(parseText(out).status, 400);
    assert.match(parseText(out).error as string, /templateId/);
  });

  it('list-endpoints v1 → GET <rest>/v1/endpoints with include query params', async () => {
    const { handlers, outbound } = harness({ jsonBody: [] });
    await handlers.get('list-endpoints')!({ includeWorkers: true });
    assert.equal(
      outbound[0].url,
      'https://rest.runpod.io/v1/endpoints?includeWorkers=true'
    );
  });
});

// ============== Log streaming (stream-pod-logs / stream-worker-logs) ==========
// Both are v2-only SSE tools. The 501-on-v1 behaviour is covered by the V2_ONLY
// sweep above; here we drive the v2 happy path through the injected `streamSse`
// seam (the real reader uses node-fetch directly, bypassing the fake fetch) and
// lock the URL/query building + the parse of the SSE `data:` frame body. The
// pure frame parser is unit-tested in mappers.test.ts.
describe('log streaming tools (v2-only)', () => {
  // A realistic SSE body: `id:` line + `data: {source,line,ts}` frame per event.
  const SSE_BODY =
    'id: 2026-07-06T22:04:13Z\n' +
    'data: {"source":"system","line":"create 20GB volume","ts":"2026-07-06T22:04:13Z"}\n\n' +
    'id: 2026-07-06T22:04:14Z\n' +
    'data: {"source":"container","line":"CUDA 12.4.1","ts":"2026-07-06T22:04:14Z"}\n\n';

  function recordingStreamSse(raw: string = SSE_BODY) {
    const calls: Array<{ url: string; maxWaitMs: number; maxBytes: number }> =
      [];
    const streamSse = async (
      url: string,
      o: { maxWaitMs: number; maxBytes: number }
    ) => {
      calls.push({ url, ...o });
      return { raw, truncated: false };
    };
    return { calls, streamSse };
  }

  it('stream-pod-logs → GET <v2>/v2/pods/{id}/logs, parses SSE frames', async () => {
    await withV2(async () => {
      const { calls, streamSse } = recordingStreamSse();
      const { handlers } = harness({ streamSse });
      const out = await handlers.get('stream-pod-logs')!({ podId: 'pod_1' });
      assert.equal(calls.length, 1);
      // `source: both` is the default → NO source query param.
      assert.equal(
        calls[0].url,
        'https://v2-rest.runpod.io/v2/pods/pod_1/logs'
      );
      assert.equal(calls[0].maxWaitMs, 5000);
      assert.equal(calls[0].maxBytes, 256 * 1024);
      const body = parseText(out);
      assert.equal(body.count, 2);
      const items = body.items as Array<Record<string, string>>;
      assert.deepEqual(items[0], {
        source: 'system',
        line: 'create 20GB volume',
        ts: '2026-07-06T22:04:13Z',
      });
      assert.equal(items[1].source, 'container');
      assert.equal(body.truncated, false);
    });
  });

  it('stream-pod-logs forwards source/tail/since + maxWaitMs (source=both omitted)', async () => {
    await withV2(async () => {
      const { calls, streamSse } = recordingStreamSse();
      const { handlers } = harness({ streamSse });
      await handlers.get('stream-pod-logs')!({
        podId: 'pod_2',
        source: 'container',
        tail: 50,
        since: '2026-05-01T22:00:00Z',
        maxWaitMs: 8000,
      });
      assert.equal(
        calls[0].url,
        'https://v2-rest.runpod.io/v2/pods/pod_2/logs?source=container&tail=50&since=2026-05-01T22%3A00%3A00Z'
      );
      assert.equal(calls[0].maxWaitMs, 8000);
    });
  });

  it('stream-worker-logs → GET <v2>/v2/serverless/{id}/workers/{workerId}/logs', async () => {
    await withV2(async () => {
      const { calls, streamSse } = recordingStreamSse();
      const { handlers } = harness({ streamSse });
      const out = await handlers.get('stream-worker-logs')!({
        endpointId: 'ep_1',
        workerId: 'w_9',
        source: 'system',
        tail: 0,
      });
      assert.equal(
        calls[0].url,
        'https://v2-rest.runpod.io/v2/serverless/ep_1/workers/w_9/logs?source=system&tail=0'
      );
      assert.equal(parseText(out).count, 2);
    });
  });
});

// The v1 catalog path (list-gpu-types / list-data-centers) goes through
// `graphqlRequest`, which now uses the INJECTED fetch (not module-level
// node-fetch). This proves the seam: under v1 the GraphQL call is captured by
// the harness fake — before the fix it bypassed the seam and hit the real net.
describe('v1 catalog GraphQL uses the injected fetch (offline seam)', () => {
  it('list-gpu-types v1 → POST <graphql> via the fake fetch, no real network', async () => {
    const { handlers, outbound } = harness({
      jsonBody: {
        data: {
          gpuTypes: [
            {
              id: 'A100',
              displayName: 'A100',
              memoryInGb: 80,
              secureCloud: true,
              communityCloud: true,
              lowestPrice: { stockStatus: 'High' },
            },
          ],
        },
      },
    });
    const out = await handlers.get('list-gpu-types')!({});
    // Captured by the injected fetch ⇒ the seam holds (no real network).
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, 'https://api.runpod.io/graphql');
    assert.equal(outbound[0].method, 'POST');
    assert.ok((parseText(out).items as unknown[]).length >= 1);
  });
});

// ============== Network volume storage tier + endpoint releases =============
describe('v2 additions surfaced by the spec resync', () => {
  it('create-network-volume forwards volumeType as `type`', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('create-network-volume')!({
        name: 'v',
        size: 50,
        dataCenterId: 'EU-RO-1',
        volumeType: 'HIGH_PERFORMANCE',
      });
      const body = JSON.parse(outbound[0].body!);
      assert.deepEqual(body, {
        name: 'v',
        size: 50,
        dataCenter: 'EU-RO-1',
        type: 'HIGH_PERFORMANCE',
      });
      assert.equal('volumeType' in body, false);
    });
  });

  it('create-network-volume omits `type` when volumeType is unset (DC default)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('create-network-volume')!({
        name: 'v',
        size: 50,
        dataCenterId: 'EU-RO-1',
      });
      assert.equal('type' in JSON.parse(outbound[0].body!), false);
    });
  });

  it('list-endpoint-releases → GET <v2>/v2/serverless/{id}/releases, keeps rollout metadata', async () => {
    await withV2(async () => {
      const releases = Array.from({ length: 2 }, (_, i) => ({ id: `r${i}` }));
      const { handlers, outbound } = harness({
        jsonBody: { releases, endpointVersion: 12, rollout: { done: true } },
      });
      const out = await handlers.get('list-endpoint-releases')!({
        endpointId: 'ep_1',
      });
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/serverless/ep_1/releases'
      );
      assert.equal(outbound[0].method, 'GET');
      const reply = parseText(out);
      assert.equal((reply.items as unknown[]).length, 2);
      assert.equal(reply.endpointVersion, 12);
    });
  });
});
