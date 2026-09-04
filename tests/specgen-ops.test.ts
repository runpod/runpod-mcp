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

test('SDK requests carry a deadline: a silent host becomes a 504 tool result, not a hang', async () => {
  const { createToolContext } = await import('../src/specgen/context.js');
  const { runTool } = await import('../src/specgen/tools/util.js');
  const realFetch = globalThis.fetch;
  // A host that accepts the request and never answers: resolve only when the
  // request's signal aborts. Without a deadline this promise never settles —
  // the exact leak PR #83 fixed on the old surface.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return new Promise((_, reject) => {
      assert.ok(signal, 'SDK fetch must carry an AbortSignal');
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  }) as typeof fetch;
  try {
    const ctx = createToolContext({
      apiKey: 'rpa_test',
      tracking: { transport: 'stdio', serverVersion: 'test' },
      sdkTimeoutMs: 50,
    });
    const started = Date.now();
    const result = await runTool(async () => {
      await ctx.sdk.GET('/v2/pods');
      return { ok: true, status: 200, payload: {} };
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 504);
    assert.ok(
      Date.now() - started < 5_000,
      'must fail by the deadline, not the platform reaper'
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a WAF-style empty-body 429 surfaces as a failed call with the header wait, end to end', async () => {
  const { createSpecgenServer } = await import('../src/specgen/server.js');
  const { createToolContext } = await import('../src/specgen/context.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import(
    '@modelcontextprotocol/sdk/inMemory.js'
  );
  const realFetch = globalThis.fetch;
  // Empty body + Content-Length: 0 — openapi-fetch returns error: undefined
  // for this, and Retry-After is the only usable signal.
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 429,
      headers: { 'content-length': '0', 'retry-after': '1724' },
    })) as typeof fetch;
  try {
    const server = createSpecgenServer(
      // Retries off: this pins the un-retried surface behavior; retry tuning
      // has its own bound in context.ts (SDK_RETRY).
      createToolContext({ apiKey: 'rpa_test', sdkRetry: false }),
      'test'
    );
    const client = new Client({ name: 'test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = (await client.callTool({
      name: 'list-pods',
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(
      res.isError,
      true,
      'an empty-body 429 must not read as success'
    );
    const body = JSON.parse(res.content[0].text) as { hint?: string };
    // The TOP-LEVEL hint (the recovery channel bare clients read) must carry
    // the header-derived wait, not the generic "pause briefly" text.
    assert.match(body.hint ?? '', /1724s/);
    await client.close();
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a runtime-plane 429 hint survives runTool nesting to the top-level hint', async () => {
  const { runTool } = await import('../src/specgen/tools/util.js');
  const { HttpError } = await import('../src/specgen/clients/http-error.js');
  const { withRateLimitHint } = await import('../src/_shared/rate-limit.js');
  // The runtime client throws HttpError with the enriched payload; runTool
  // nests it under `detail`. The server merge must find detail.hint.
  const headers = new Headers({ 'retry-after': '90' });
  const result = await runTool(async () => {
    throw new HttpError(
      'Runpod runtime API error (429)',
      429,
      withRateLimitHint({ error: 'rate limit exceeded' }, headers)
    );
  });
  const payload = result.payload as { detail?: { hint?: string } };
  const topLevelHint =
    (payload as { hint?: string }).hint ?? payload.detail?.hint;
  assert.match(topLevelHint ?? '', /90s/);
});

test('boundedFetch deadline covers the body read, not just the headers', async () => {
  const { boundedFetch } = await import(
    '../src/specgen/clients/bounded-fetch.js'
  );
  // A backend that sends headers plus a partial body, then stalls forever:
  // the regression cleared the timer when headers arrived, leaving .text()
  // unbounded until the platform reaper.
  let sourceController: ReadableStreamDefaultController<Uint8Array>;
  const stalled = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      // never closes
    },
  });
  const stubFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    // Tie the stream's fate to the abort signal like a real socket: the
    // source errors when the request is aborted.
    signal?.addEventListener('abort', () => {
      sourceController.error(signal.reason);
    });
    return new Response(stalled, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const started = Date.now();
  const response = await boundedFetch(stubFetch, 50)('https://x.test/');
  await assert.rejects(
    () => response.text(),
    (err: unknown) =>
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError'),
    'the mid-body stall must abort at the deadline'
  );
  assert.ok(Date.now() - started < 5_000);
});

test('the stdio handshake clientInfo lands in the outbound User-Agent', async () => {
  const { createSpecgenServer } = await import('../src/specgen/server.js');
  const { createToolContext } = await import('../src/specgen/context.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import(
    '@modelcontextprotocol/sdk/inMemory.js'
  );
  const realFetch = globalThis.fetch;
  const agents: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h =
      input instanceof Request ? input.headers : new Headers(init?.headers);
    agents.push(h.get('user-agent') ?? '');
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const server = createSpecgenServer(
      createToolContext({
        apiKey: 'rpa_test',
        tracking: { transport: 'stdio', serverVersion: 'test' },
        sdkRetry: false,
      }),
      'test'
    );
    const client = new Client({ name: 'claude-code', version: '9.9.9' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.callTool({ name: 'list-pods', arguments: {} });
    await client.close();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(agents.length, 1);
  assert.match(agents[0], /client=claude-code; client_version=9\.9\.9/);
  assert.match(agents[0], /surface=v2/);
});
