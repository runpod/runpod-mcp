import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleMcpRequest, parseTraceIdHeader } from '#src/http';
import { createToolContext } from '#src/specgen/context';

// ============== Request trace: the X-Trace-ID request header ==============
// A caller (the Runpod Console assistant) sends X-Trace-ID so a REST v2 call
// joins the caller's turn in the API request log. The hosted server forwards
// it to REST v2 only. Tracing must never break a request, so a bad value is
// dropped, not refused.

class FakeResponse extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  constructor(private readonly finish: () => void) {
    super();
  }
  writeHead(statusCode: number, hdrs?: Record<string, string>) {
    this.statusCode = statusCode;
    Object.assign(this.headers, hdrs ?? {});
    return this;
  }
  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers[name] = String(value);
    return this;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk?: string) {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.writableFinished = true;
    this.emit('finish');
    this.finish();
  }
}

function fakeReqRes(body: unknown, extraHeaders: object = {}) {
  const req = {
    method: 'POST',
    url: '/',
    headers: {
      host: 'mcp.test',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer rpa_x',
      'user-agent': 'probe/0',
      ...extraHeaders,
    },
    body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fake = new FakeResponse(finish);
  return { req, res: fake as unknown as ServerResponse, fake, finished };
}

const reqWith = (value: string | string[] | undefined) =>
  ({
    headers: value === undefined ? {} : { 'x-trace-id': value },
  }) as unknown as IncomingMessage;

describe('parseTraceIdHeader', () => {
  it('a well-formed id is kept', () => {
    for (const id of ['asst_t1_r2', 'a.b-c_D9', 'a'.repeat(128)]) {
      assert.equal(parseTraceIdHeader(reqWith(id)), id);
    }
  });

  it('absent, empty, spaced, listed, oversized or repeated is dropped', () => {
    for (const value of [
      undefined,
      '',
      ' a',
      'a b',
      'a, b',
      'a'.repeat(129),
      'tëst',
      'a/b',
      'a\r\nX-Evil: 1',
      ['a', 'b'],
    ]) {
      assert.equal(
        parseTraceIdHeader(reqWith(value)),
        undefined,
        `for ${JSON.stringify(value)}`
      );
    }
  });
});

interface Seen {
  url: string;
  traceId: string | null;
}

async function withRecordedFetch(
  run: (seen: Seen[]) => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, traceId: request.headers.get('x-trace-id') });
    const isGraphql = request.url.endsWith('/graphql');
    return new Response(isGraphql ? '{"data":{}}' : '[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    await run(seen);
  } finally {
    globalThis.fetch = original;
  }
}

describe('createToolContext — X-Trace-ID outbound', () => {
  it('REST v2 requests (sdk and sse) carry the trace id', async () => {
    await withRecordedFetch(async (seen) => {
      const ctx = createToolContext({
        apiKey: 'rpa_x',
        traceId: 'asst_t1_r2',
        sdkRetry: false,
      });
      await ctx.sdk.GET('/v2/pods');
      await ctx.sse('https://api.runpod.io/v2/pods/p1/logs', {
        maxWaitMs: 50,
        maxBytes: 1000,
      });
      assert.equal(seen.length, 2);
      for (const call of seen) assert.equal(call.traceId, 'asst_t1_r2');
    });
  });

  it('GraphQL and the Serverless runtime never get it', async () => {
    await withRecordedFetch(async (seen) => {
      const ctx = createToolContext({
        apiKey: 'rpa_x',
        traceId: 'asst_t1_r2',
        sdkRetry: false,
        tracking: { transport: 'http', serverVersion: '0.0.0' },
      });
      await ctx.graphql.public('{ x }');
      await ctx.graphql.authed('{ x }');
      await ctx.runtime('ep1', '/health');
      assert.equal(seen.length, 3);
      for (const call of seen) assert.equal(call.traceId, null, call.url);
    });
  });

  it('no trace id → no header', async () => {
    await withRecordedFetch(async (seen) => {
      const ctx = createToolContext({ apiKey: 'rpa_x', sdkRetry: false });
      await ctx.sdk.GET('/v2/pods');
      assert.equal(seen[0].traceId, null);
    });
  });
});

const listPods = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'list-pods', arguments: {} },
};

describe('handleMcpRequest — X-Trace-ID reaches the REST call', () => {
  it('list-pods sends the inbound trace id upstream', async () => {
    await withRecordedFetch(async (seen) => {
      const { req, res, fake, finished } = fakeReqRes(listPods, {
        'x-trace-id': 'asst_t1_r2',
      });
      await handleMcpRequest(req, res, {
        verifyCredential: async () => ({ status: 'valid' as const }),
      });
      await finished;
      assert.equal(fake.statusCode, 200);
      const pods = seen.filter((call) => call.url.includes('/v2/pods'));
      assert.ok(pods.length >= 1, JSON.stringify(seen));
      for (const call of pods) assert.equal(call.traceId, 'asst_t1_r2');
    });
  });

  it('a malformed trace id is dropped and the call is still served', async () => {
    await withRecordedFetch(async (seen) => {
      const { req, res, fake, finished } = fakeReqRes(listPods, {
        'x-trace-id': 'bad value',
      });
      await handleMcpRequest(req, res, {
        verifyCredential: async () => ({ status: 'valid' as const }),
      });
      await finished;
      assert.equal(fake.statusCode, 200);
      const pods = seen.filter((call) => call.url.includes('/v2/pods'));
      assert.ok(pods.length >= 1, JSON.stringify(seen));
      for (const call of pods) assert.equal(call.traceId, null);
    });
  });
});
