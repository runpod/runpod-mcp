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
  status?: number;
  contentType?: string;
}) {
  const handlers = new Map<string, Handler>();
  const outbound: OutboundRecord[] = [];

  const fakeServer = {
    // registerTools calls server.tool(name, [description], schema, handler).
    // The handler is the last function argument.
    tool(name: string, ...args: unknown[]) {
      const handler = args.filter((a) => typeof a === 'function').pop() as
        | Handler
        | undefined;
      if (handler) handlers.set(name, handler);
    },
    // trackingHeaders reads this per request.
    server: {
      getClientVersion: () => ({ name: 'test-client', version: '9.9.9' }),
    },
  } as unknown as McpServer;

  const status = opts?.status ?? 200;
  const fakeFetch = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ) => {
    outbound.push({ url, method: init.method, body: init.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (n: string) =>
          n.toLowerCase() === 'content-type'
            ? (opts?.contentType ?? 'application/json')
            : null,
      },
      json: async () => opts?.jsonBody ?? [],
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
