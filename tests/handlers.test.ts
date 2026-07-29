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
  headers?: Record<string, string>;
}

function harness(opts?: {
  // What the fake fetch returns (defaults to an empty JSON array — a v1 list).
  jsonBody?: unknown;
  // A queue of bodies returned one-per-call (for poll loops like stream-job).
  jsonBodies?: unknown[];
  status?: number;
  contentType?: string;
  // Per-call responses, consumed one per outbound request (falls back to the
  // single-response options once exhausted). For handlers that make more than one
  // call with DIFFERENT statuses — e.g. update-endpoint's scaler lookup followed
  // by the PATCH.
  steps?: Array<{ status?: number; jsonBody?: unknown; text?: string }>;
  // Fake SSE reader for stream-pod-logs (the real one uses node-fetch directly,
  // bypassing the injected fetch). Records its calls and returns canned text.
  streamSse?: (
    url: string,
    o: { maxWaitMs: number; maxBytes: number }
  ) => Promise<{ raw: string; truncated: boolean }>;
  // Observer for the ToolContext 401 hook (hosted credential invalidation).
  onUnauthorized?: () => void;
  // Transport under the SSE reader, so a test can drive an SSE 401 through the
  // observer (injecting `streamSse` replaces the reader and bypasses it).
  sseStatus?: number;
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

  const queue = opts?.jsonBodies ? [...opts.jsonBodies] : null;
  const steps = opts?.steps ? [...opts.steps] : null;
  const fakeFetch = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ) => {
    outbound.push({
      url,
      method: init.method,
      body: init.body,
      headers: init.headers,
    });
    const step = steps?.shift();
    const status = step?.status ?? opts?.status ?? 200;
    const jsonBody = step
      ? (step.jsonBody ?? {})
      : queue
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
      text: async () => step?.text ?? '',
    };
  };

  registerTools(
    fakeServer,
    {
      apiKey: 'rpa_test',
      transport: 'stdio',
      ...(opts?.onUnauthorized ? { onUnauthorized: opts.onUnauthorized } : {}),
    },
    {
      fetch: fakeFetch as Parameters<typeof registerTools>[2]['fetch'],
      ...(opts?.streamSse ? { streamSse: opts.streamSse } : {}),
      ...(opts?.sseStatus
        ? {
            sseFetch: async () => ({
              ok: opts.sseStatus! >= 200 && opts.sseStatus! < 300,
              status: opts.sseStatus!,
              text: async () => 'denied',
              body: null,
            }),
          }
        : {}),
    } as Parameters<typeof registerTools>[2]
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
      // Typed schema: routing `type` at the top level, idleTimeout under
      // `workers`, and the scaler target under a per-variant key.
      assert.equal(body.type, 'QUEUE');
      assert.deepEqual(body.workers, { min: 0, max: 3, idleTimeout: 5 });
      assert.deepEqual(body.scaling, { type: 'QUEUE_DELAY', queueDelay: 4 });
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

  it('create-endpoint v2 rejects LOAD_BALANCER + QUEUE_DELAY before any request', async () => {
    // A load balancer has no queue to measure, so the combination can never be
    // valid — caught client-side rather than spending a round trip on a 422.
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = await handlers.get('create-endpoint')!({
        name: 'e',
        imageName: 'img:2',
        gpuPoolIds: ['AMPERE_80'],
        endpointType: 'LOAD_BALANCER',
        scalerType: 'QUEUE_DELAY',
      });
      assert.equal(outbound.length, 0);
      assert.equal(parseText(out).status, 400);
      assert.match(parseText(out).error as string, /no request queue/);
    });
  });

  it('create-endpoint v2 rejects a fractional scalerValue under REQUEST_COUNT', async () => {
    // REQUEST_COUNT counts whole in-flight requests. The schema can only floor
    // scalerValue at 0.5 (the QUEUE_DELAY minimum), so the integer half is
    // checked here, against the scaler actually being sent.
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = await handlers.get('create-endpoint')!({
        name: 'e',
        imageName: 'img:2',
        gpuPoolIds: ['AMPERE_80'],
        scalerType: 'REQUEST_COUNT',
        scalerValue: 2.5,
      });
      assert.equal(outbound.length, 0);
      assert.equal(parseText(out).status, 400);
      assert.match(parseText(out).error as string, /integer >= 1/);
    });
  });

  it('create-endpoint v2 applies the integer bound to a LOAD_BALANCER default scaler', async () => {
    // No scalerType passed: LOAD_BALANCER defaults to REQUEST_COUNT, so the
    // bound has to be judged on the resolved scaler, not the named one.
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      const out = await handlers.get('create-endpoint')!({
        name: 'e',
        imageName: 'img:2',
        gpuPoolIds: ['AMPERE_80'],
        endpointType: 'LOAD_BALANCER',
        scalerValue: 1.5,
      });
      assert.equal(outbound.length, 0);
      assert.equal(parseText(out).status, 400);
      assert.match(parseText(out).error as string, /integer >= 1/);
    });
  });

  it('create-endpoint v2 allows a fractional scalerValue under QUEUE_DELAY', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'ep_qd' } });
      await handlers.get('create-endpoint')!({
        name: 'e',
        imageName: 'img:2',
        gpuPoolIds: ['AMPERE_80'],
        scalerType: 'QUEUE_DELAY',
        scalerValue: 0.5,
      });
      assert.equal(outbound.length, 1);
      assert.deepEqual(JSON.parse(outbound[0].body!).scaling, {
        type: 'QUEUE_DELAY',
        queueDelay: 0.5,
      });
    });
  });

  it('create-endpoint v2 defaults LOAD_BALANCER to the REQUEST_COUNT scaler', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'ep_lb' } });
      await handlers.get('create-endpoint')!({
        name: 'e',
        imageName: 'img:2',
        gpuPoolIds: ['AMPERE_80'],
        endpointType: 'LOAD_BALANCER',
      });
      const body = JSON.parse(outbound[0].body!);
      assert.equal(body.type, 'LOAD_BALANCER');
      assert.deepEqual(body.scaling, {
        type: 'REQUEST_COUNT',
        requestCount: 4,
      });
    });
  });

  it('update-endpoint reads the current scaler when only scalerValue is given', async () => {
    // `scaling` is a union keyed on the scaler type, so changing just the target
    // needs the endpoint's existing scaler first — a GET, then the PATCH.
    await withV2(async () => {
      const { handlers, outbound } = harness({
        steps: [
          { status: 200, jsonBody: { scaling: { type: 'REQUEST_COUNT' } } },
          { status: 200, jsonBody: { id: 'ep_1' } },
        ],
      });
      await handlers.get('update-endpoint')!({
        endpointId: 'ep_1',
        scalerValue: 7,
      });
      assert.equal(outbound.length, 2);
      assert.equal(outbound[0].method, 'GET');
      assert.equal(
        outbound[0].url,
        'https://v2-rest.runpod.io/v2/serverless/ep_1'
      );
      assert.equal(outbound[1].method, 'PATCH');
      assert.deepEqual(JSON.parse(outbound[1].body!).scaling, {
        type: 'REQUEST_COUNT',
        requestCount: 7,
      });
    });
  });

  it('update-endpoint rejects a fractional scalerValue against a REQUEST_COUNT endpoint', async () => {
    // The caller named no scaler, so the bound can only be judged after the GET
    // resolves it. The PATCH must not go out.
    await withV2(async () => {
      const { handlers, outbound } = harness({
        steps: [
          { status: 200, jsonBody: { scaling: { type: 'REQUEST_COUNT' } } },
        ],
      });
      const out = await handlers.get('update-endpoint')!({
        endpointId: 'ep_1',
        scalerValue: 7.5,
      });
      assert.equal(outbound.length, 1, 'expected the GET only, no PATCH');
      assert.equal(outbound[0].method, 'GET');
      assert.equal(parseText(out).status, 400);
      assert.match(parseText(out).error as string, /integer >= 1/);
    });
  });

  it('update-endpoint treats an unrecognized current scaler as QUEUE_DELAY', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        steps: [
          { status: 200, jsonBody: { scaling: {} } },
          { status: 200, jsonBody: { id: 'ep_1' } },
        ],
      });
      await handlers.get('update-endpoint')!({
        endpointId: 'ep_1',
        scalerValue: 3,
      });
      assert.deepEqual(JSON.parse(outbound[1].body!).scaling, {
        type: 'QUEUE_DELAY',
        queueDelay: 3,
      });
    });
  });

  it('update-endpoint skips that read when the caller names the scaler', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: { id: 'ep_1' } });
      await handlers.get('update-endpoint')!({
        endpointId: 'ep_1',
        scalerType: 'QUEUE_DELAY',
        scalerValue: 3,
      });
      assert.equal(outbound.length, 1);
      assert.equal(outbound[0].method, 'PATCH');
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

// Hub listings are served by the same public GraphQL path as the v1 catalog,
// on BOTH v1 and v2 (no REST home for the Hub yet). These pin the outbound
// query shape, the client-side filters, and the compact mapped output.
describe('list-hub-repos (public GraphQL Hub catalog)', () => {
  const listings = [
    {
      id: 'lst_vllm',
      repoId: '1',
      title: 'vLLM',
      description: 'OpenAI-compatible LLM endpoints',
      repoName: 'worker-vllm',
      repoOwner: 'runpod-workers',
      createdAt: '2025-03-20T07:03:50.990Z',
      updatedAt: '2026-07-28T15:34:28.240Z',
      views: 1560,
      stars: 460,
      deploys: 41921,
      language: 'Python',
      category: 'language',
      tags: ['llm', 'vllm'],
      type: 'SERVERLESS',
      listedRelease: {
        id: 'rel_vllm',
        name: 'v2.22.5',
        tagName: 'v2.22.5',
        createdAt: '2026-06-26T18:48:13.000Z',
        config: '{"runsOn":"GPU","containerDiskInGb":150}',
        build: {
          id: 'b1',
          imageName: 'registry.runpod.net/worker-vllm:9e1c48313',
        },
      },
    },
    {
      id: 'lst_comfy',
      repoId: '2',
      title: 'ComfyUI',
      description: 'Generate images with ComfyUI',
      repoName: 'worker-comfyui',
      repoOwner: 'runpod-workers',
      createdAt: '2025-03-12T15:26:43.567Z',
      updatedAt: '2026-07-28T15:34:33.647Z',
      views: 425,
      stars: 721,
      deploys: 13198,
      language: 'Python',
      category: 'image',
      tags: ['comfyui', 'stable-diffusion'],
      type: 'SERVERLESS',
      listedRelease: {
        id: 'rel_comfy',
        name: '5.8.6',
        tagName: '5.8.6',
        createdAt: '2026-06-17T08:16:31.000Z',
        config: '{"runsOn":"GPU","containerDiskInGb":20}',
        build: {
          id: 'b2',
          imageName: 'registry.runpod.net/worker-comfyui:066a11c49',
        },
      },
    },
    {
      id: 'lst_axolotl',
      repoId: '3',
      title: 'Axolotl Fine-Tuning',
      description: 'Serverless fine-tuning of open-source LLMs',
      repoName: 'axolotl',
      repoOwner: 'axolotl-ai-cloud',
      createdAt: '2025-05-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      views: 100,
      stars: 9000,
      deploys: 500,
      language: 'Python',
      category: 'language',
      tags: ['fine-tuning', 'lora'],
      type: 'SERVERLESS',
      listedRelease: null,
    },
  ];

  it('POSTs the listings query to the public GraphQL endpoint (works on v1 and v2, no auth path)', async () => {
    const { handlers, outbound } = harness({
      jsonBody: { data: { listings } },
    });
    const out = await handlers.get('list-hub-repos')!({});
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, 'https://api.runpod.io/graphql');
    assert.equal(outbound[0].method, 'POST');
    const body = JSON.parse(outbound[0].body!) as { query: string };
    assert.match(body.query, /listings\(input: \{\}\)/);
    assert.match(body.query, /listedRelease/);
    // config is large — must NOT be requested unless includeConfig is set.
    assert.doesNotMatch(body.query, /\bconfig\b/);
    assert.equal((parseText(out).items as unknown[]).length, 3);
  });

  it('same GraphQL path under v2 (no REST home for the Hub)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({
        jsonBody: { data: { listings } },
      });
      await handlers.get('list-hub-repos')!({});
      assert.equal(outbound[0].url, 'https://api.runpod.io/graphql');
    });
  });

  it('maps to compact output: repo, urls, and the deploy-critical hubReleaseId + imageName; sorted most-deployed first', async () => {
    const { handlers } = harness({ jsonBody: { data: { listings } } });
    const out = await handlers.get('list-hub-repos')!({});
    const items = parseText(out).items as Array<Record<string, unknown>>;
    assert.deepEqual(
      items.map((i) => i.repo),
      [
        'runpod-workers/worker-vllm',
        'runpod-workers/worker-comfyui',
        'axolotl-ai-cloud/axolotl',
      ]
    );
    const vllm = items[0];
    assert.equal(
      vllm.hubUrl,
      'https://console.runpod.io/hub/runpod-workers/worker-vllm'
    );
    assert.equal(
      vllm.githubUrl,
      'https://github.com/runpod-workers/worker-vllm'
    );
    const release = vllm.listedRelease as Record<string, unknown>;
    assert.equal(release.hubReleaseId, 'rel_vllm');
    assert.equal(
      release.imageName,
      'registry.runpod.net/worker-vllm:9e1c48313'
    );
    assert.equal('config' in release, false);
    // A listing without a listed release maps to null, not a crash.
    assert.equal(items[2].listedRelease, null);
  });

  it('filters client-side: searchTerm (title/tags), category, repoOwner, type', async () => {
    const run = async (params: Record<string, unknown>) => {
      const { handlers } = harness({ jsonBody: { data: { listings } } });
      const out = await handlers.get('list-hub-repos')!(params);
      return (parseText(out).items as Array<{ repo: string }>).map(
        (i) => i.repo
      );
    };
    assert.deepEqual(await run({ searchTerm: 'comfy' }), [
      'runpod-workers/worker-comfyui',
    ]);
    assert.deepEqual(await run({ searchTerm: 'LoRA' }), [
      'axolotl-ai-cloud/axolotl',
    ]);
    assert.deepEqual(await run({ category: 'image' }), [
      'runpod-workers/worker-comfyui',
    ]);
    assert.deepEqual(await run({ repoOwner: 'axolotl-ai-cloud' }), [
      'axolotl-ai-cloud/axolotl',
    ]);
    assert.deepEqual((await run({ type: 'SERVERLESS' })).length, 3);
    assert.deepEqual(await run({ type: 'POD' }), []);
  });

  it('includeConfig:true requests config in the query and returns it parsed', async () => {
    const { handlers, outbound } = harness({
      jsonBody: { data: { listings } },
    });
    const out = await handlers.get('list-hub-repos')!({
      includeConfig: true,
      searchTerm: 'vllm',
    });
    const body = JSON.parse(outbound[0].body!) as { query: string };
    assert.match(body.query, /\bconfig\b/);
    const items = parseText(out).items as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    const release = items[0].listedRelease as Record<string, unknown>;
    assert.deepEqual(release.config, { runsOn: 'GPU', containerDiskInGb: 150 });
  });

  it('caps results with the shared pagination envelope', async () => {
    const { handlers } = harness({ jsonBody: { data: { listings } } });
    const out = await handlers.get('list-hub-repos')!({ limit: 1 });
    const payload = parseText(out);
    assert.equal((payload.items as unknown[]).length, 1);
    const pagination = payload.pagination as Record<string, unknown>;
    assert.equal(pagination.total, 3);
    assert.equal(pagination.truncated, true);
    assert.ok(pagination.nextCursor);
  });

  it('orders deploy-count ties deterministically, so paging cannot skip or duplicate', async () => {
    // Each page re-fetches the whole catalog and `listings(input: {})` promises
    // no order, so sorting on `deploys` alone lets ties move between requests
    // and page 2 re-shows or skips entries. Same listings in a different input
    // order must yield the same page.
    const tied = [
      { ...listings[0], id: 'l_c', repoName: 'c', deploys: 0 },
      { ...listings[0], id: 'l_a', repoName: 'a', deploys: 0 },
      { ...listings[0], id: 'l_b', repoName: 'b', deploys: 0 },
    ];
    const order = async (input: typeof tied) => {
      const { handlers } = harness({ jsonBody: { data: { listings: input } } });
      const out = await handlers.get('list-hub-repos')!({});
      return (parseText(out).items as Array<{ id: string }>).map((i) => i.id);
    };

    const first = await order(tied);
    const reversed = await order([...tied].reverse());
    assert.deepEqual(first, ['l_a', 'l_b', 'l_c']);
    assert.deepEqual(reversed, first);
  });
});

// Public Endpoints (managed model APIs) share the public GraphQL path with the
// Hub catalog. These pin the outbound query, the metadata parsing, the
// live-only default, and the client-side filters.
describe('list-public-endpoints (public GraphQL catalog)', () => {
  const allAiApiPublicConfigs = [
    {
      id: 'cfg_kimi',
      aiApiId: 'moonshot-kimi',
      modelName: 'kimi-k3',
      displayName: 'Kimi',
      description: 'Advanced reasoning and chat.',
      metadata:
        '{"cost":4,"owner":"moonshot","source":"language","tag":"text-to-text","priceString":"$4.00 per 1m output tokens"}',
      isLive: true,
      createdAt: '2026-06-11T18:27:51.932Z',
      updatedAt: '2026-07-27T20:45:41.152Z',
    },
    {
      id: 'cfg_hailuo',
      aiApiId: 'minimax-hailuo-2-3-fast',
      modelName: 'minimax/hailuo-2-3',
      displayName: 'Hailuo 2.3 Fast',
      description: 'AI video generation.',
      metadata:
        '{"cost":0.19,"owner":"minimax","source":"video","tag":"image-to-video","priceString":"$0.19 per second"}',
      isLive: true,
      createdAt: '2026-05-08T20:58:56.912Z',
      updatedAt: '2026-05-08T21:16:17.411Z',
    },
    {
      id: 'cfg_dead',
      aiApiId: 'legacy-model',
      modelName: 'legacy/model',
      displayName: 'Legacy Model',
      description: 'Retired.',
      metadata: 'not-json',
      isLive: false,
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    },
  ];
  const jsonBody = { data: { allAiApiPublicConfigs } };

  it('POSTs the allAiApiPublicConfigs query to the public GraphQL endpoint', async () => {
    const { handlers, outbound } = harness({ jsonBody });
    const out = await handlers.get('list-public-endpoints')!({});
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].url, 'https://api.runpod.io/graphql');
    assert.equal(outbound[0].method, 'POST');
    const body = JSON.parse(outbound[0].body!) as { query: string };
    assert.match(body.query, /allAiApiPublicConfigs/);
    // live-only by default → the retired config is hidden
    assert.equal((parseText(out).items as unknown[]).length, 2);
  });

  it('same GraphQL path under v2 (no REST home for public endpoints)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody });
      await handlers.get('list-public-endpoints')!({});
      assert.equal(outbound[0].url, 'https://api.runpod.io/graphql');
    });
  });

  it('maps to compact output with parsed metadata (owner, modality, pricing) and the runtime baseUrl; sorted by display name', async () => {
    const { handlers } = harness({ jsonBody });
    const out = await handlers.get('list-public-endpoints')!({});
    const items = parseText(out).items as Array<Record<string, unknown>>;
    assert.deepEqual(
      items.map((i) => i.endpointId),
      ['minimax-hailuo-2-3-fast', 'moonshot-kimi']
    );
    const kimi = items[1];
    assert.equal(kimi.displayName, 'Kimi');
    assert.equal(kimi.owner, 'moonshot');
    assert.equal(kimi.modality, 'language');
    assert.equal(kimi.pricing, '$4.00 per 1m output tokens');
    assert.equal(kimi.baseUrl, 'https://api.runpod.ai/v2/moonshot-kimi');
    // metadata JSON string must not leak through raw
    assert.equal('metadata' in kimi, false);
  });

  it('includeOffline:true also lists non-live endpoints and survives malformed metadata', async () => {
    const { handlers } = harness({ jsonBody });
    const out = await handlers.get('list-public-endpoints')!({
      includeOffline: true,
    });
    const items = parseText(out).items as Array<Record<string, unknown>>;
    assert.equal(items.length, 3);
    const legacy = items.find((i) => i.endpointId === 'legacy-model')!;
    assert.equal(legacy.isLive, false);
    // 'not-json' metadata → fields absent, no crash
    assert.equal(legacy.owner, undefined);
  });

  it('filters client-side: searchTerm, modality, owner', async () => {
    const run = async (params: Record<string, unknown>) => {
      const { handlers } = harness({ jsonBody });
      const out = await handlers.get('list-public-endpoints')!(params);
      return (parseText(out).items as Array<{ endpointId: string }>).map(
        (i) => i.endpointId
      );
    };
    assert.deepEqual(await run({ searchTerm: 'kimi' }), ['moonshot-kimi']);
    assert.deepEqual(await run({ searchTerm: 'image-to-video' }), [
      'minimax-hailuo-2-3-fast',
    ]);
    assert.deepEqual(await run({ modality: 'video' }), [
      'minimax-hailuo-2-3-fast',
    ]);
    assert.deepEqual(await run({ owner: 'moonshot' }), ['moonshot-kimi']);
    assert.deepEqual(await run({ owner: 'nobody' }), []);
  });

  it('caps results with the shared pagination envelope', async () => {
    const { handlers } = harness({ jsonBody });
    const out = await handlers.get('list-public-endpoints')!({ limit: 1 });
    const payload = parseText(out);
    assert.equal((payload.items as unknown[]).length, 1);
    const pagination = payload.pagination as Record<string, unknown>;
    assert.equal(pagination.total, 2);
    assert.equal(pagination.truncated, true);
    assert.ok(pagination.nextCursor);
  });
});

// deploy-hub-repo: resolves the release from the public catalog (call 1), then
// submits the authenticated saveEndpoint mutation with variables (call 2).
// These pin the mutation input the console builds — hubReleaseId, config-derived
// hardware, env defaults + overrides — and the guard rails that fail BEFORE any
// mutation is sent.
describe('deploy-hub-repo (authenticated GraphQL saveEndpoint)', () => {
  const catalogListings = [
    {
      id: 'lst_vllm',
      repoId: '1',
      title: 'vLLM',
      description: 'LLM endpoints',
      repoName: 'worker-vllm',
      repoOwner: 'runpod-workers',
      createdAt: '2025-03-20T07:03:50.990Z',
      updatedAt: '2026-07-28T15:34:28.240Z',
      views: 1,
      stars: 1,
      deploys: 100,
      language: 'Python',
      category: 'language',
      tags: ['llm'],
      type: 'SERVERLESS',
      listedRelease: {
        id: 'rel_vllm',
        name: 'v2.22.5',
        tagName: 'v2.22.5',
        createdAt: '2026-06-26T18:48:13.000Z',
        config: JSON.stringify({
          runsOn: 'GPU',
          containerDiskInGb: 150,
          gpuIds: 'ADA_80_PRO,AMPERE_80',
          gpuCount: 1,
          allowedCudaVersions: ['12.8', '12.4', '12.6'],
          env: [
            {
              key: 'MODEL_NAME',
              input: { type: 'huggingface', required: true },
            },
            { key: 'MAX_NUM_SEQS', input: { type: 'number', default: 256 } },
            {
              key: 'TRUST_REMOTE_CODE',
              input: {
                type: 'boolean',
                default: false,
                trueValue: '1',
                falseValue: '0',
              },
            },
            { key: 'TOKENIZER', input: { type: 'string', default: '' } },
          ],
        }),
        build: { id: 'b1', imageName: 'registry.runpod.net/worker-vllm:9e1' },
      },
    },
    {
      id: 'lst_pod',
      repoId: '2',
      title: 'Some Pod Thing',
      description: 'pod listing',
      repoName: 'pod-thing',
      repoOwner: 'someone',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      views: 0,
      stars: 0,
      deploys: 0,
      language: 'Python',
      category: 'image',
      tags: [],
      type: 'POD',
      listedRelease: {
        id: 'rel_pod',
        name: '1.0',
        tagName: '1.0',
        createdAt: '2025-01-01T00:00:00.000Z',
        config: '{}',
        build: { id: 'b2', imageName: 'registry.runpod.net/pod-thing:abc' },
      },
    },
    {
      id: 'lst_nogpu',
      repoId: '3',
      title: 'No GPU Config',
      description: 'config without gpuIds',
      repoName: 'no-gpu',
      repoOwner: 'someone',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      views: 0,
      stars: 0,
      deploys: 0,
      language: 'Python',
      category: 'language',
      tags: [],
      type: 'SERVERLESS',
      listedRelease: {
        id: 'rel_nogpu',
        name: '1.0',
        tagName: '1.0',
        createdAt: '2025-01-01T00:00:00.000Z',
        config: '{"containerDiskInGb":200,"env":[]}',
        build: { id: 'b3', imageName: 'registry.runpod.net/no-gpu:abc' },
      },
    },
  ];
  const catalogBody = { data: { listings: catalogListings } };
  const saveBody = {
    data: {
      saveEndpoint: {
        id: 'ep_new',
        name: 'vLLM v2.22.5',
        gpuIds: 'ADA_80_PRO,AMPERE_80',
        gpuCount: 1,
        workersMin: 0,
        workersMax: 3,
        idleTimeout: 5,
        scalerType: 'QUEUE_DELAY',
        scalerValue: 4,
        flashBootType: 'FLASHBOOT',
        templateId: 'tpl_new',
      },
    },
  };

  it('happy path (by repo): catalog query then authenticated saveEndpoint with the console-shaped input', async () => {
    const { handlers, outbound } = harness({
      jsonBodies: [catalogBody, saveBody],
    });
    const out = await handlers.get('deploy-hub-repo')!({
      repo: 'runpod-workers/worker-vllm',
      env: { MODEL_NAME: 'openai/gpt-oss-20b', EXTRA_FLAG: 'yes' },
    });

    assert.equal(outbound.length, 2);
    // Call 1: public catalog resolution (query with config, no bearer auth).
    assert.equal(outbound[0].url, 'https://api.runpod.io/graphql');
    assert.match(
      JSON.parse(outbound[0].body!).query,
      /listings\(input: \{\}\)/
    );
    assert.equal('Authorization' in (outbound[0].headers ?? {}), false);
    // Call 2: authenticated mutation with variables.
    assert.equal(outbound[1].url, 'https://api.runpod.io/graphql');
    assert.equal(outbound[1].headers?.Authorization, 'Bearer rpa_test');
    const body = JSON.parse(outbound[1].body!) as {
      query: string;
      variables: { input: Record<string, unknown> };
    };
    assert.match(
      body.query,
      /mutation saveEndpoint\(\$input: EndpointInput!\)/
    );
    const input = body.variables.input;
    assert.equal(input.hubReleaseId, 'rel_vllm');
    assert.equal(input.name, 'vLLM v2.22.5');
    assert.equal(input.type, 'QB');
    assert.equal(input.gpuIds, 'ADA_80_PRO,AMPERE_80');
    assert.equal(input.gpuCount, 1);
    assert.equal(input.workersMin, 0);
    assert.equal(input.workersMax, null);
    assert.equal(input.idleTimeout, 5);
    assert.equal(input.scalerType, 'QUEUE_DELAY');
    assert.equal(input.scalerValue, 4);
    assert.equal(input.executionTimeoutMs, 600000);
    assert.equal(input.flashBootType, 'FLASHBOOT');
    // min of ['12.8','12.4','12.6'] numeric-aware, list joined verbatim.
    assert.equal(input.minCudaVersion, '12.4');
    assert.equal(input.allowedCudaVersions, '12.8,12.4,12.6');
    const template = input.template as Record<string, unknown>;
    assert.equal(template.imageName, 'registry.runpod.net/worker-vllm:9e1');
    assert.equal(template.containerDiskInGb, 150);
    assert.match(
      String(template.name),
      /^vLLM v2\.22\.5__template__[a-z0-9]+$/
    );
    // Env: schema defaults + overrides + passthrough of unknown keys; booleans
    // serialized through trueValue/falseValue.
    assert.deepEqual(template.env, [
      { key: 'MODEL_NAME', value: 'openai/gpt-oss-20b' },
      { key: 'MAX_NUM_SEQS', value: '256' },
      { key: 'TRUST_REMOTE_CODE', value: '0' },
      { key: 'TOKENIZER', value: '' },
      { key: 'EXTRA_FLAG', value: 'yes' },
    ]);
    // Reply carries the new endpoint and what was deployed.
    const payload = parseText(out);
    assert.equal((payload.endpoint as { id: string }).id, 'ep_new');
    assert.equal(
      (payload.deployed as { hubReleaseId: string }).hubReleaseId,
      'rel_vllm'
    );
  });

  it('resolves by hubReleaseId and honors overrides (name, gpu, workers, disk, flashboot)', async () => {
    const { handlers, outbound } = harness({
      jsonBodies: [catalogBody, saveBody],
    });
    await handlers.get('deploy-hub-repo')!({
      hubReleaseId: 'rel_vllm',
      name: 'my-vllm',
      env: { MODEL_NAME: 'm' },
      gpuIds: 'AMPERE_80',
      gpuCount: 2,
      containerDiskInGb: 300,
      workersMin: 1,
      workersMax: 5,
      idleTimeout: 30,
      scalerType: 'REQUEST_COUNT',
      scalerValue: 2,
      executionTimeoutMs: 900000,
      flashboot: 'OFF',
    });
    const input = (
      JSON.parse(outbound[1].body!) as {
        variables: { input: Record<string, unknown> };
      }
    ).variables.input;
    assert.equal(input.hubReleaseId, 'rel_vllm');
    assert.equal(input.name, 'my-vllm');
    assert.equal(input.gpuIds, 'AMPERE_80');
    assert.equal(input.gpuCount, 2);
    assert.equal(input.workersMin, 1);
    assert.equal(input.workersMax, 5);
    assert.equal(input.idleTimeout, 30);
    assert.equal(input.scalerType, 'REQUEST_COUNT');
    assert.equal(input.scalerValue, 2);
    assert.equal(input.executionTimeoutMs, 900000);
    assert.equal(input.flashBootType, 'OFF');
    assert.equal(
      (input.template as Record<string, unknown>).containerDiskInGb,
      300
    );
  });

  it('fails BEFORE the mutation: missing required env vars', async () => {
    const { handlers, outbound } = harness({ jsonBodies: [catalogBody] });
    const out = await handlers.get('deploy-hub-repo')!({
      repo: 'runpod-workers/worker-vllm',
    });
    assert.equal(outbound.length, 1); // catalog only, no mutation
    assert.match(parseText(out).error as string, /MODEL_NAME/);
  });

  it('fails BEFORE the mutation: no gpuIds in config and none provided', async () => {
    const { handlers, outbound } = harness({ jsonBodies: [catalogBody] });
    const out = await handlers.get('deploy-hub-repo')!({
      repo: 'someone/no-gpu',
    });
    assert.equal(outbound.length, 1);
    assert.match(parseText(out).error as string, /gpuIds/);
  });

  it('fails BEFORE the mutation: POD listings, unknown repos, and missing identifiers', async () => {
    const pod = harness({ jsonBodies: [catalogBody] });
    const podOut = await pod.handlers.get('deploy-hub-repo')!({
      repo: 'someone/pod-thing',
    });
    assert.match(parseText(podOut).error as string, /only SERVERLESS/);

    const unknown = harness({ jsonBodies: [catalogBody] });
    const unknownOut = await unknown.handlers.get('deploy-hub-repo')!({
      repo: 'nobody/nothing',
    });
    assert.match(parseText(unknownOut).error as string, /No Hub listing/);

    const none = harness({ jsonBodies: [catalogBody] });
    const noneOut = await none.handlers.get('deploy-hub-repo')!({});
    assert.equal(none.outbound.length, 0); // no calls at all
    assert.match(parseText(noneOut).error as string, /repo .*or hubReleaseId/);
  });
});

// set-endpoint-gpus: reads the endpoint's current settings (call 1) and echoes
// them into an authenticated saveEndpoint mutation with only the GPU fields
// changed (call 2). The echo matters: saveEndpoint resets omitted endpoint
// scalars to server defaults (verified live), so these tests pin that every
// current value is carried over verbatim.
//
// Assertions are derived FROM the fixture, not from a copy of the
// implementation's object literal. A hand-copied expectation is a
// change-detector that passes when a field is missing from both sides at once —
// exactly how templateId/minCudaVersion/allowedCudaVersions/compliance/
// modelReferences went unnoticed. `preservedKeys` is the real contract: add a
// field to the fixture and the test demands it be echoed.
describe('set-endpoint-gpus (authenticated GraphQL GPU pinning)', () => {
  const endpoints = [
    {
      id: 'ep_pinme',
      name: 'my-endpoint',
      gpuIds: 'AMPERE_16',
      gpuCount: 1,
      workersMin: 2,
      workersMax: 7,
      idleTimeout: 42,
      scalerType: 'REQUEST_COUNT',
      scalerValue: 9,
      executionTimeoutMs: 123000,
      flashBootType: 'PRIORITY_FLASHBOOT',
      type: 'QB',
      locations: 'US-TX-3',
      templateId: 'tpl_pinme',
      allowedCudaVersions: '12.4,12.8',
      minCudaVersion: '12.4',
      compliance: ['GDPR'],
      modelReferences: ['model_a'],
      networkVolumeIds: [{ networkVolumeId: 'nv_1', dataCenterId: 'US-TX-3' }],
    },
    {
      id: 'ep_plain',
      name: 'plain-endpoint',
      gpuIds: 'ADA_24',
      gpuCount: 1,
      workersMin: 0,
      workersMax: 1,
      idleTimeout: 5,
      scalerType: 'QUEUE_DELAY',
      scalerValue: 4,
      executionTimeoutMs: 600000,
      flashBootType: 'FLASHBOOT',
      type: 'QB',
      locations: null,
      templateId: 'tpl_plain',
      // No CUDA constraint or tags on this endpoint: these read null.
      allowedCudaVersions: null,
      minCudaVersion: null,
      compliance: null,
      modelReferences: null,
      networkVolumeIds: [],
    },
  ];
  // Fixture keys that must survive the echo unchanged. gpuIds is the one field
  // the tool replaces; networkVolumeIds is asserted separately because read and
  // write use different shapes.
  const preservedKeys = Object.keys(endpoints[0]).filter(
    (k) => k !== 'gpuIds' && k !== 'networkVolumeIds'
  );
  const queryBody = { data: { myself: { endpoints } } };
  const saveBody = {
    data: {
      saveEndpoint: {
        id: 'ep_pinme',
        name: 'my-endpoint',
        gpuIds: 'AMPERE_16,-NVIDIA RTX A4500',
        gpuCount: 1,
        workersMin: 2,
        workersMax: 7,
      },
    },
  };

  it('echoes every current endpoint scalar into the mutation, changing only gpuIds (both calls Bearer-authed)', async () => {
    const { handlers, outbound } = harness({
      jsonBodies: [queryBody, saveBody],
    });
    const out = await handlers.get('set-endpoint-gpus')!({
      endpointId: 'ep_pinme',
      gpuIds: 'AMPERE_16,-NVIDIA RTX A4500',
    });

    assert.equal(outbound.length, 2);
    assert.equal(outbound[0].url, 'https://api.runpod.io/graphql');
    assert.equal(outbound[0].headers?.Authorization, 'Bearer rpa_test');
    assert.match(JSON.parse(outbound[0].body!).query, /myself[\s\S]*endpoints/);
    assert.equal(outbound[1].headers?.Authorization, 'Bearer rpa_test');
    const input = (
      JSON.parse(outbound[1].body!) as {
        variables: { input: Record<string, unknown> };
      }
    ).variables.input;
    // Every preserved key must be echoed with the value the read returned.
    for (const key of preservedKeys) {
      assert.deepEqual(
        input[key],
        (endpoints[0] as Record<string, unknown>)[key],
        `${key} must be echoed back unchanged (saveEndpoint resets omitted fields)`
      );
    }
    assert.equal(input.gpuIds, 'AMPERE_16,-NVIDIA RTX A4500');
    // NetworkVolumeIdsInput accepts networkVolumeId ONLY; the server rejects
    // dataCenterId outright, breaking every endpoint with a volume. So assert
    // the exact key set, not just the id.
    assert.deepEqual(input.networkVolumeIds, [{ networkVolumeId: 'nv_1' }]);
    for (const entry of input.networkVolumeIds as Array<
      Record<string, unknown>
    >) {
      assert.deepEqual(
        Object.keys(entry),
        ['networkVolumeId'],
        'NetworkVolumeIdsInput accepts networkVolumeId only'
      );
    }
    // No stray fields beyond the echo + the GPU change.
    assert.deepEqual(
      Object.keys(input).sort(),
      [...preservedKeys, 'gpuIds', 'networkVolumeIds'].sort()
    );
    const payload = parseText(out);
    assert.equal(payload.previousGpuIds, 'AMPERE_16');
    assert.equal((payload.endpoint as { id: string }).id, 'ep_pinme');
  });

  it('minCudaVersion/allowedCudaVersions are overridable and otherwise echo the current values', async () => {
    const { handlers, outbound } = harness({
      jsonBodies: [queryBody, saveBody],
    });
    await handlers.get('set-endpoint-gpus')!({
      endpointId: 'ep_pinme',
      gpuIds: 'AMPERE_16',
      minCudaVersion: '12.0',
      allowedCudaVersions: '12.8,12.7,12.6,12.5,12.4',
    });
    const input = (
      JSON.parse(outbound[1].body!) as {
        variables: { input: Record<string, unknown> };
      }
    ).variables.input;
    assert.equal(input.minCudaVersion, '12.0');
    assert.equal(input.allowedCudaVersions, '12.8,12.7,12.6,12.5,12.4');
  });

  it('builds the gpuIds string from pools + excludeGpuTypeIds; empty volume list echoes null; gpuCount overridable', async () => {
    const { handlers, outbound } = harness({
      jsonBodies: [queryBody, saveBody],
    });
    await handlers.get('set-endpoint-gpus')!({
      endpointId: 'ep_plain',
      pools: ['AMPERE_16', 'AMPERE_24'],
      excludeGpuTypeIds: ['NVIDIA RTX A4500', 'NVIDIA L4'],
      gpuCount: 2,
    });
    const input = (
      JSON.parse(outbound[1].body!) as {
        variables: { input: Record<string, unknown> };
      }
    ).variables.input;
    assert.equal(
      input.gpuIds,
      'AMPERE_16,AMPERE_24,-NVIDIA RTX A4500,-NVIDIA L4'
    );
    assert.equal(input.gpuCount, 2);
    assert.equal(input.networkVolumeIds, null);
    assert.equal(input.workersMax, 1);
    // ep_plain has a template but no CUDA constraint, tags or model references:
    // the template is carried over, the null fields omitted rather than sent as
    // explicit nulls.
    assert.equal(input.templateId, 'tpl_plain');
    for (const key of [
      'allowedCudaVersions',
      'minCudaVersion',
      'compliance',
      'modelReferences',
    ]) {
      assert.equal(key in input, false, `${key} is null — omit, do not send`);
    }
  });

  it('sends the authenticated GraphQL host, not the public-discovery one', async () => {
    // The API key must not follow RUNPOD_PUBLIC_GRAPHQL_URL — the documented
    // credential-free discovery override, freely pointed at stubs.
    const prevPublic = process.env.RUNPOD_PUBLIC_GRAPHQL_URL;
    const prevAuthed = process.env.RUNPOD_AUTHED_GRAPHQL_URL;
    process.env.RUNPOD_PUBLIC_GRAPHQL_URL = 'https://public.stub/graphql';
    process.env.RUNPOD_AUTHED_GRAPHQL_URL = 'https://authed.example/graphql';
    try {
      const { handlers, outbound } = harness({
        jsonBodies: [queryBody, saveBody],
      });
      await handlers.get('set-endpoint-gpus')!({
        endpointId: 'ep_pinme',
        gpuIds: 'ADA_24',
      });
      for (const call of outbound) {
        assert.equal(call.url, 'https://authed.example/graphql');
        assert.equal(call.headers?.Authorization, 'Bearer rpa_test');
      }
    } finally {
      if (prevPublic === undefined)
        delete process.env.RUNPOD_PUBLIC_GRAPHQL_URL;
      else process.env.RUNPOD_PUBLIC_GRAPHQL_URL = prevPublic;
      if (prevAuthed === undefined)
        delete process.env.RUNPOD_AUTHED_GRAPHQL_URL;
      else process.env.RUNPOD_AUTHED_GRAPHQL_URL = prevAuthed;
    }
  });

  it('fails BEFORE any mutation: unknown endpoint (after read), and missing GPU params (no calls at all)', async () => {
    const unknown = harness({ jsonBodies: [queryBody] });
    const unknownOut = await unknown.handlers.get('set-endpoint-gpus')!({
      endpointId: 'ep_nope',
      gpuIds: 'ADA_24',
    });
    assert.equal(unknown.outbound.length, 1);
    assert.match(
      parseText(unknownOut).error as string,
      /No Serverless endpoint/
    );

    const none = harness({ jsonBodies: [queryBody] });
    const noneOut = await none.handlers.get('set-endpoint-gpus')!({
      endpointId: 'ep_pinme',
    });
    assert.equal(none.outbound.length, 0);
    assert.match(parseText(noneOut).error as string, /gpuIds .*or pools/);
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

// ============== 401 observer (hosted credential invalidation) ==============
// The hosted server caches a "credential is valid" verdict. A tool call that
// 401s proves that verdict wrong before its TTL expires, so the runtime reports
// it through ToolContext.onUnauthorized and the next request re-checks — that is
// what lets the server answer 401 + WWW-Authenticate instead of serving another
// wrapped-200 error for the rest of the TTL.
describe('ToolContext.onUnauthorized (401 observer)', () => {
  it('fires when an outbound call answers 401', async () => {
    let fired = 0;
    const { handlers } = harness({
      status: 401,
      jsonBody: { error: 'Unauthorized' },
      onUnauthorized: () => fired++,
    });
    await assert.rejects(() => handlers.get('list-pods')!({}));
    assert.equal(fired, 1, 'onUnauthorized was not called for a 401');
  });

  it('does not fire on success, or on a non-401 failure', async () => {
    let fired = 0;
    const ok = harness({ jsonBody: [], onUnauthorized: () => fired++ });
    await ok.handlers.get('list-pods')!({});
    assert.equal(fired, 0, 'fired on a 200');

    const forbidden = harness({
      status: 403,
      jsonBody: { error: 'Forbidden' },
      onUnauthorized: () => fired++,
    });
    await assert.rejects(() => forbidden.handlers.get('list-pods')!({}));
    assert.equal(fired, 0, 'fired on a 403 — only 401 means a dead credential');
  });

  it('is optional — the stdio path registers no observer and still works', async () => {
    const { handlers, outbound } = harness({ jsonBody: [] });
    await handlers.get('list-pods')!({});
    assert.equal(outbound.length, 1);
  });
});

// The SSE reader binds its own transport, so it does NOT go through the JSON
// clients' fetch. It must still report a 401, or a credential that dies during
// stream-pod-logs / stream-worker-logs is never noticed by the hosted server.
describe('ToolContext.onUnauthorized — SSE tools', () => {
  it('fires when the SSE stream itself answers 401', async () => {
    await withV2(async () => {
      let fired = 0;
      const { handlers } = harness({
        sseStatus: 401,
        onUnauthorized: () => fired++,
      });
      // The tool surfaces the failure in its reply rather than throwing; what
      // matters here is that the 401 reached the observer either way.
      await handlers.get('stream-pod-logs')!({ podId: 'p' }).catch(() => {});
      assert.equal(fired, 1, 'an SSE 401 bypassed the observer');
    });
  });

  it('does not fire when the SSE stream answers a non-401 failure', async () => {
    await withV2(async () => {
      let fired = 0;
      const { handlers } = harness({
        sseStatus: 403,
        onUnauthorized: () => fired++,
      });
      await handlers.get('stream-pod-logs')!({ podId: 'p' }).catch(() => {});
      assert.equal(fired, 0, 'only a 401 means a dead credential');
    });
  });
});

// The public GraphQL catalog query sends no Authorization header, so a 401 from
// that host says nothing about the caller's credential. Observing it would drop a
// good cached verdict and push every caller back through the pre-flight — and
// under an egress-IP block, every catalog call would do it.
describe('onUnauthorized ignores the unauthenticated GraphQL path', () => {
  it('does not fire when the public catalog query 401s', async () => {
    let fired = 0;
    const { handlers, outbound } = harness({
      status: 401,
      jsonBody: { errors: [{ message: 'blocked' }] },
      onUnauthorized: () => fired++,
    });
    await handlers.get('list-gpu-types')!({}).catch(() => {});
    assert.ok(
      outbound.some((c) => c.url.includes('graphql')),
      'expected the public GraphQL call'
    );
    assert.equal(fired, 0, 'a no-credential 401 invalidated the verdict');
  });
});
