import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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

describe('pod routing under RUNPOD_REST_VERSION=v2', () => {
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
      assert.equal(body.dataCenter, 'US-TX-3');
      assert.deepEqual(body.mounts, {
        persistent: { size: 40, path: '/workspace' },
      });
    });
  });

  it('create-pod v2 with a partial volume drops mounts (no size-only mount)', async () => {
    await withV2(async () => {
      const { handlers, outbound } = harness({ jsonBody: {} });
      await handlers.get('create-pod')!({ imageName: 'i', volumeInGb: 40 });
      const body = JSON.parse(outbound[0].body!);
      assert.equal('mounts' in body, false);
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
