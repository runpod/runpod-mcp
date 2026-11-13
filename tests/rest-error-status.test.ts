import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { restError } from '#src/specgen/clients/rest-result';
import { createSpecgenServer } from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// ============== Upstream HTTP status in every REST error payload ==============
// A client must tell a Runpod 401/429 from an MCP-side failure, and it reads
// the status from the tool result payload. An empty or non-JSON error body
// (an edge answering a bare 403/429, an empty 401) must still carry it.

const res = (status: number, statusText = '') =>
  new Response(null, { status, statusText });

describe('restError — payload status', () => {
  it('an empty body carries the status', () => {
    for (const error of [undefined, null, '']) {
      const result = restError(res(401, 'Unauthorized'), error);
      assert.deepEqual(result.payload, { error: 'Unauthorized', status: 401 });
    }
    assert.deepEqual(restError(res(403), undefined).payload, {
      error: 'HTTP 403',
      status: 403,
    });
  });

  it('a non-JSON body carries the status and keeps the text', () => {
    assert.deepEqual(restError(res(502), 'Bad gateway').payload, {
      error: 'Bad gateway',
      status: 502,
    });
  });

  it('a JSON body without a status gets one', () => {
    assert.deepEqual(restError(res(404), { error: 'pod not found' }).payload, {
      error: 'pod not found',
      status: 404,
    });
  });

  it('a body that already carries a status is unchanged', () => {
    const top = { error: 'bad', status: 400, errors: [] };
    assert.equal(restError(res(400), top).payload, top);
    const nested = { error: 'x', detail: { status: 409 } };
    assert.equal(restError(res(409), nested).payload, nested);
  });

  it('an empty 429 carries the status and the wait hint', () => {
    const payload = restError(res(429), undefined).payload as Record<
      string,
      unknown
    >;
    assert.equal(payload.status, 429);
    assert.equal(typeof payload.hint, 'string');
  });
});

async function callWithUpstream(
  status: number,
  body: string | null
): Promise<{ isError: unknown; payload: Record<string, unknown> }> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(body, { status })) as typeof fetch;
  try {
    const server = createSpecgenServer(
      createToolContext({ apiKey: 'rpa_x', sdkRetry: false })
    );
    const client = new Client({ name: 'probe', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const result = await client.callTool({ name: 'list-pods', arguments: {} });
    const content = result.content as { text: string }[];
    await client.close();
    return { isError: result.isError, payload: JSON.parse(content[0].text) };
  } finally {
    globalThis.fetch = original;
  }
}

describe('tool result — upstream status reaches the MCP client', () => {
  for (const status of [401, 403, 429, 502]) {
    it(`an empty ${status} body`, async () => {
      const { isError, payload } = await callWithUpstream(status, null);
      assert.equal(isError, true);
      assert.equal(payload.status, status);
    });
  }

  it('a non-JSON body', async () => {
    const { payload } = await callWithUpstream(403, '<html>denied</html>');
    assert.equal(payload.status, 403);
  });
});

describe('runTool — an HttpError result carries the status', () => {
  it('an empty 429 from a log stream reaches the client with status 429', async () => {
    const { runTool } = await import('#src/specgen/tools/util');
    const { createSseReader } = await import('#src/specgen/clients/sse');
    const reader = createSseReader({
      apiKey: 'rpa_x',
      fetchImpl: (async () =>
        new Response('', { status: 429 })) as typeof fetch,
    });
    const result = await runTool(async () => {
      await reader('https://api.runpod.io/v2/pods/p1/logs', {
        maxWaitMs: 10,
        maxBytes: 1000,
      });
      return { ok: true, status: 200, payload: {} };
    });
    assert.equal(result.ok, false);
    assert.equal((result.payload as { status?: number }).status, 429);
  });
});
