import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { restError } from '#src/specgen/clients/rest-result';
import { createSpecgenServer } from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';
import { runTool } from '#src/specgen/tools/util';
import { createSseReader } from '#src/specgen/clients/sse';
import { createRuntimeClient } from '#src/specgen/clients/runtime';
import { createGraphqlClient } from '#src/specgen/clients/graphql';
import { HttpError, missingKeyError } from '#src/specgen/clients/http-error';
import { collectJobStream } from '#src/specgen/tools/jobs';
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
  });

  it('a nested detail.status does not stand in for the top-level status', () => {
    const nested = { error: 'x', detail: { status: 409 } };
    assert.deepEqual(restError(res(409), nested).payload, {
      ...nested,
      status: 409,
    });
  });

  it('a non-numeric status in the body is replaced by the HTTP status', () => {
    assert.deepEqual(restError(res(502), { status: 'error' }).payload, {
      status: 502,
    });
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

// ============== `status` only for an upstream non-OK HTTP response ==============
// `status` in the payload means Runpod answered with a non-OK HTTP status. An
// error the MCP raised itself (no request sent, a deadline, a GraphQL resolver
// error on an HTTP 200) keeps the result status but has no payload status.

async function payloadOf(fail: () => Promise<unknown>) {
  const result = await runTool(async () => {
    await fail();
    return { ok: true, status: 200, payload: {} };
  });
  assert.equal(result.ok, false);
  return {
    status: result.status,
    payload: result.payload as Record<string, unknown>,
  };
}

const reply = (status: number, body = '') =>
  (async () => new Response(body, { status })) as typeof fetch;

describe('runTool — payload status only for an upstream HTTP error', () => {
  it('a missing API key has no payload status', async () => {
    const { status, payload } = await payloadOf(async () => {
      throw missingKeyError();
    });
    assert.equal(status, 401);
    assert.equal('status' in payload, false);
  });

  it('the runtime endpointId check has no payload status', async () => {
    const runtime = createRuntimeClient({
      apiKey: 'rpa_x',
      fetchImpl: () => assert.fail('no request may be sent'),
    });
    const { status, payload } = await payloadOf(() =>
      runtime('bad/id', '/health')
    );
    assert.equal(status, 400);
    assert.equal('status' in payload, false);
  });

  it('a runtime non-OK response has the payload status', async () => {
    const runtime = createRuntimeClient({
      apiKey: 'rpa_x',
      fetchImpl: reply(404, '{"error":"not found"}'),
    });
    const { payload } = await payloadOf(() => runtime('ep1', '/health'));
    assert.equal(payload.status, 404);
  });

  it('a GraphQL non-OK response has the payload status', async () => {
    const graphql = createGraphqlClient({
      publicUrl: 'https://example.invalid/graphql',
      fetchImpl: reply(503),
    });
    const { payload } = await payloadOf(() => graphql.public('query { x }'));
    assert.equal(payload.status, 503);
  });

  it('a GraphQL resolver error on an HTTP 200 has no payload status', async () => {
    const graphql = createGraphqlClient({
      publicUrl: 'https://example.invalid/graphql',
      fetchImpl: reply(
        200,
        JSON.stringify({
          errors: [
            { message: 'nope', extensions: { code: 'UNAUTHENTICATED' } },
          ],
        })
      ),
    });
    const { status, payload } = await payloadOf(() =>
      graphql.public('query { x }')
    );
    assert.equal(status, 401);
    assert.equal('status' in payload, false);
  });

  it('a job poll that times out has no payload status', async () => {
    const { status, payload } = await payloadOf(() =>
      collectJobStream({
        poll: async () => {
          throw new DOMException('deadline', 'TimeoutError');
        },
        budgetMs: 60_000,
        holdMs: 1_000,
        pollIntervalMs: 0,
      })
    );
    assert.equal(status, 504);
    assert.equal('status' in payload, false);
  });

  it('a job poll that keeps getting an upstream 503 has the payload status', async () => {
    const { payload } = await payloadOf(() =>
      collectJobStream({
        poll: async () => {
          throw new HttpError('Runpod runtime API error (503)', 503, '', {
            upstream: true,
          });
        },
        budgetMs: 60_000,
        holdMs: 1_000,
        pollIntervalMs: 0,
      })
    );
    assert.equal(payload.status, 503);
  });
});
