import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/index.js';

// The OAuth discovery documents are static per host, so they carry a CDN
// caching directive and repeat fetches skip the function. These tests pin the
// directive onto the two discovery routes and off the MCP endpoint, whose
// responses are per-caller.

function fakeReqRes(method: string, url: string) {
  const state: Record<string, string> = {};
  const req = {
    method,
    url,
    headers: { host: 'mcp.test' },
    body: undefined,
    on() {},
  } as unknown as Parameters<typeof handler>[0];
  const res = {
    setHeader(name: string, value: string) {
      state[name] = value;
      return this;
    },
    getHeader(name: string) {
      return state[name];
    },
    status() {
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
    writeHead() {
      return this;
    },
    on() {},
  } as unknown as Parameters<typeof handler>[1];
  return { req, res, state };
}

describe('OAuth discovery responses are CDN-cacheable', () => {
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
  ]) {
    it(`GET ${path} carries s-maxage so the CDN serves repeat fetches`, async () => {
      const { req, res, state } = fakeReqRes('GET', path);
      await handler(req, res).catch(() => {});
      const cacheControl = state['Cache-Control'];
      assert.ok(cacheControl, 'no Cache-Control set on the discovery response');
      assert.match(cacheControl, /\bpublic\b/);
      assert.match(cacheControl, /\bs-maxage=[1-9]\d*/);
      // max-age=0: endpoint changes propagate as soon as the CDN copy expires.
      assert.match(cacheControl, /\bmax-age=0\b/);
    });
  }

  it('the MCP endpoint itself is never marked cacheable', async () => {
    // MCP responses are per-caller; a CDN-cached copy would replay one
    // caller's response to another. Pin the directive's absence on the
    // catch-all route so it stays out of the shared prelude in api/index.ts.
    const { req, res, state } = fakeReqRes('POST', '/');
    await handler(req, res).catch(() => {});
    assert.equal(state['Cache-Control'], undefined);
  });
});
