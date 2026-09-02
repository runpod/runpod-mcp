// Phase-1 ops seam: caller hashing, the rate-limit stub, and the denial path
// through a real MCP round trip (in-memory transport, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { callerId, noopRateLimiter } from '../src/specgen/ops.js';
import { createSpecgenServer } from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';

test('callerId is stable per token, distinct across tokens, never the token', () => {
  const a = callerId('rpa_secret_A');
  assert.equal(a, callerId('rpa_secret_A'));
  assert.notEqual(a, callerId('rpa_secret_B'));
  assert.equal(a.length, 12);
  assert.ok(!a.includes('rpa'));
  assert.equal(callerId(undefined), 'anonymous');
});

test('noop limiter always admits', async () => {
  assert.deepEqual(await noopRateLimiter('c', 'list-pods'), { allowed: true });
});

test('a denying limiter surfaces as a retryable tool error, not a crash', async () => {
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test',
    { rateLimiter: async () => ({ allowed: false, retryAfterS: 30 }) }
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const res = (await client.callTool({ name: 'list-pods', arguments: {} })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(res.isError, true);
  const body = JSON.parse(res.content[0].text);
  assert.match(body.error, /Rate limited/);
  assert.match(body.hint, /~30s/);
  await client.close();
});

test('the tracking fetch wrapper preserves Headers-instance auth headers', async () => {
  const { createToolContext } = await import('../src/specgen/context.js');
  const seen: Array<Record<string, string>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Headers may arrive inside a Request (openapi-fetch) or via init.
    const h =
      input instanceof Request ? input.headers : new Headers(init?.headers);
    seen.push({
      auth: h.get('authorization') ?? '',
      ua: h.get('user-agent') ?? '',
    });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const ctx = createToolContext({
      apiKey: 'rpa_test',
      tracking: { transport: 'stdio', serverVersion: 'test' },
    });
    // The SDK passes a Headers instance — the case the wrapper must survive.
    await ctx.sdk.GET('/v2/pods');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].auth,
    'Bearer rpa_test',
    'Authorization must survive the merge'
  );
  assert.match(seen[0].ua, /runpod-mcp-server\/test .*transport=stdio/);
});
