import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHttpClient, HttpError } from '../src/_shared/http.js';
import {
  sanitizeUaToken,
  buildTrackingHeaders,
} from '../src/_shared/tracking.js';

// ---- fake response/fetch builders (no network) ----
interface FakeResponseOpts {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  jsonBody?: unknown;
  textBody?: string;
}

function fakeResponse(opts: FakeResponseOpts) {
  const status = opts.status ?? 200;
  // Respect an explicit `contentType: null`; only default when the key is absent.
  const contentType =
    'contentType' in opts ? opts.contentType : 'application/json';
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? (contentType ?? null) : null,
    },
    json: async () => opts.jsonBody,
    text: async () => opts.textBody ?? '',
  };
}

type Captured = {
  url?: string;
  init?: { method: string; headers: Record<string, string>; body?: string };
};

function fakeFetch(resp: ReturnType<typeof fakeResponse>, captured?: Captured) {
  return async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ) => {
    if (captured) {
      captured.url = url;
      captured.init = init;
    }
    return resp;
  };
}

const noTracking = () => ({});

describe('createHttpClient — request shape', () => {
  it('passes the resolved URL through unchanged', async () => {
    const cap: Captured = {};
    const client = createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
    });
    await client('https://rest.runpod.io/v1/pods');
    assert.equal(cap.url, 'https://rest.runpod.io/v1/pods');
  });

  it('sets Authorization bearer + Content-Type + tracking headers', async () => {
    const cap: Captured = {};
    const client = createHttpClient({
      apiKey: 'rpa_abc',
      fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
      tracking: () => ({ 'User-Agent': 'ua/1', 'X-Runpod-Session-Id': 'sid' }),
      errorPrefix: 'Runpod API Error',
    });
    await client('http://x/pods');
    assert.equal(cap.init?.headers.Authorization, 'Bearer rpa_abc');
    assert.equal(cap.init?.headers['Content-Type'], 'application/json');
    assert.equal(cap.init?.headers['User-Agent'], 'ua/1');
    assert.equal(cap.init?.headers['X-Runpod-Session-Id'], 'sid');
  });

  it('defaults method to GET and sends no body', async () => {
    const cap: Captured = {};
    const client = createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
      tracking: noTracking,
      errorPrefix: 'p',
    });
    await client('http://x/pods');
    assert.equal(cap.init?.method, 'GET');
    assert.equal(cap.init?.body, undefined);
  });

  it('serializes body only for POST/PATCH', async () => {
    for (const method of ['POST', 'PATCH']) {
      const cap: Captured = {};
      const client = createHttpClient({
        apiKey: 'k',
        fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
        tracking: noTracking,
        errorPrefix: 'p',
      });
      await client('http://x/pods', method, { name: 'a' });
      assert.equal(cap.init?.body, JSON.stringify({ name: 'a' }), method);
    }
  });

  it('does NOT serialize a body for GET/DELETE', async () => {
    for (const method of ['GET', 'DELETE']) {
      const cap: Captured = {};
      const client = createHttpClient({
        apiKey: 'k',
        fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
        tracking: noTracking,
        errorPrefix: 'p',
      });
      await client('http://x/pods', method, { name: 'a' });
      assert.equal(cap.init?.body, undefined, method);
    }
  });
});

describe('createHttpClient — response handling', () => {
  const mk = (resp: ReturnType<typeof fakeResponse>) =>
    createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(resp),
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
    });

  it('parses an application/json body', async () => {
    const out = await mk(fakeResponse({ jsonBody: { id: 'p1' } }))('http://x');
    assert.deepEqual(out, { id: 'p1' });
  });

  it('parses an application/problem+json body (v2 errors are JSON, not swallowed)', async () => {
    // ok:true here just to prove the +json content-type routes to json(); the
    // error-status path is covered separately below.
    const out = await mk(
      fakeResponse({
        status: 200,
        contentType: 'application/problem+json',
        jsonBody: { detail: 'x' },
      })
    )('http://x');
    assert.deepEqual(out, { detail: 'x' });
  });

  it('204 / empty / non-JSON → { success: true, status }', async () => {
    const out = await mk(fakeResponse({ status: 204, contentType: null }))(
      'http://x'
    );
    assert.deepEqual(out, { success: true, status: 204 });

    const out2 = await mk(
      fakeResponse({ status: 200, contentType: 'text/plain' })
    )('http://x');
    assert.deepEqual(out2, { success: true, status: 200 });
  });

  it('!ok → throws HttpError carrying status + body + prefix', async () => {
    const client = mk(
      fakeResponse({ status: 404, ok: false, textBody: 'not found' })
    );
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 404);
        assert.equal(err.body, 'not found');
        assert.match(err.message, /^Runpod API Error: 404 - not found$/);
        return true;
      }
    );
  });

  it('501 throws an HttpError with status 501 (so create-pod can branch, stream-job still counts it)', async () => {
    const client = mk(
      fakeResponse({ status: 501, ok: false, textBody: 'not implemented' })
    );
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => err instanceof HttpError && err.status === 501
    );
  });

  it('error prefix is configurable per client (serverless vs rest)', async () => {
    const client = createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(
        fakeResponse({ status: 500, ok: false, textBody: 'boom' })
      ),
      tracking: noTracking,
      errorPrefix: 'Runpod Serverless API Error',
    });
    await assert.rejects(
      () => client('http://x'),
      /Runpod Serverless API Error: 500 - boom$/
    );
  });
});

describe('tracking headers', () => {
  it('sanitizeUaToken strips reserved chars and bounds length', () => {
    assert.equal(sanitizeUaToken('claude (code)'), 'claude__code_');
    assert.equal(sanitizeUaToken('a'.repeat(100)).length, 64);
  });

  it('builds the structured UA + session id', () => {
    const h = buildTrackingHeaders({
      clientName: 'Cursor',
      clientVersion: '1.2.3',
      transport: 'stdio',
      serverVersion: '1.3.0',
      sessionId: 'sid-1',
    });
    assert.equal(
      h['User-Agent'],
      'runpod-mcp-server/1.3.0 (caller=mcp; client=Cursor; client_version=1.2.3; transport=stdio)'
    );
    assert.equal(h['X-Runpod-Session-Id'], 'sid-1');
  });

  it('falls back to unknown when client identity is missing', () => {
    const h = buildTrackingHeaders({
      transport: 'http',
      serverVersion: 'dev',
      sessionId: 's',
    });
    assert.match(
      h['User-Agent'],
      /client=unknown; client_version=unknown; transport=http/
    );
  });
});
