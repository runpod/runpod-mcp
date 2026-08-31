import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/index.js';

// The OAuth discovery documents are static per host and fetched on every auth
// flow, so they must carry a CDN caching directive to be served from the edge
// instead of invoking the function. These tests pin the directive onto the two
// discovery routes — and pin it OFF the MCP endpoint itself, whose responses
// are per-caller and must never be cached.

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
      // Clients must not cache locally: a deploy that changes the advertised
      // endpoints has to propagate as soon as the CDN copy expires.
      assert.match(cacheControl, /\bmax-age=0\b/);
    });
  }

  it('the MCP endpoint itself is never marked cacheable', async () => {
    // Pin the directive's absence on the catch-all route so it can never
    // migrate into the shared prelude in api/index.ts, where the CDN would
    // start caching per-caller MCP responses.
    const { req, res, state } = fakeReqRes('POST', '/');
    await handler(req, res).catch(() => {});
    assert.equal(state['Cache-Control'], undefined);
  });
});
