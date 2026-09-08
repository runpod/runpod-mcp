import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/index.js';

// The OAuth discovery documents are derived only from the request host, so they
// carry a CDN caching directive and repeat fetches skip the function. These
// tests pin the directive onto the two discovery routes and off the MCP
// endpoint, whose responses are per-caller and must never be shared.
// Ported from #86 against the v1 surface.

function fakeReqRes(method: string, url: string) {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  const req = {
    method,
    url,
    headers: { host: 'mcp.test' },
    body: undefined,
    on() {},
  } as unknown as Parameters<typeof handler>[0];
  const res = {
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
    getHeader(name: string) {
      return headers[name];
    },
    status(code: number) {
      statusCode = code;
      return this;
    },
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    json() {
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
    on() {},
  } as unknown as Parameters<typeof handler>[1];
  return { req, res, headers, status: () => statusCode };
}

describe('OAuth discovery responses are CDN-cacheable', () => {
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
  ]) {
    it(`GET ${path} carries s-maxage so the CDN serves repeat fetches`, async () => {
      const { req, res, headers, status } = fakeReqRes('GET', path);
      await handler(req, res);
      // Assert we actually reached the handler: without this the header
      // assertions below would also pass on a route that 404'd early.
      assert.equal(status(), 200);
      const cacheControl = headers['Cache-Control'];
      assert.ok(cacheControl, 'no Cache-Control set on the discovery response');
      assert.match(cacheControl, /\bpublic\b/);
      assert.match(cacheControl, /\bs-maxage=[1-9]\d*/);
      assert.match(cacheControl, /\bstale-while-revalidate=[1-9]\d*/);
      // max-age=0: an endpoint change propagates once the CDN copy expires,
      // rather than being pinned in every client for s-maxage seconds.
      assert.match(cacheControl, /\bmax-age=0\b/);
    });
  }

  it('the MCP endpoint itself is never marked cacheable', async () => {
    // A CDN-cached MCP response would replay one caller's response to another.
    // This is a no-credential POST, so it is rejected before any MCP work —
    // which is the point: the directive must not live in the shared prelude
    // that every route passes through.
    const { req, res, headers, status } = fakeReqRes('POST', '/');
    await handler(req, res);
    assert.equal(status(), 401, 'expected the credential pre-flight to reject');
    assert.equal(headers['Cache-Control'], undefined);
  });
});
