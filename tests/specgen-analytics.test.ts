// Privacy contract for the PostHog analytics helper: off by default, opt-out
// honored, and the captured payload never contains the key or arguments.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  captureLoopBlocked,
  captureResourceCall,
  captureToolCall,
  analyticsCallerId,
  recordedArgumentValues,
} from '#src/specgen/analytics';
import { createSpecgenServer } from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';

const realFetch = globalThis.fetch;
let captured: Array<{ url: string; body: string }> = [];

beforeEach(() => {
  captured = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({ url: String(input), body: String(init?.body) });
    return new Response('{"status":1}', { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.POSTHOG_API_KEY;
  delete process.env.MCP_ANALYTICS_SALT;
});

const EVENT = {
  tool: 'get-pod',
  ok: false,
  status: 429,
  durationMs: 12,
  transport: 'http' as const,
  serverVersion: '4.0.0',
  clientName: 'claude-code',
};

test('captures nothing without POSTHOG_API_KEY (local default)', () => {
  captureToolCall('rpa_SECRETKEY', EVENT);
  assert.equal(captured.length, 0);
});

test('the captured payload never contains the API key, and the id is a stable HMAC', () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  process.env.MCP_ANALYTICS_SALT = 'salt-1';
  captureToolCall('rpa_SECRETKEY', EVENT);
  assert.equal(captured.length, 1);
  const { body } = captured[0];
  assert.ok(!body.includes('rpa_SECRETKEY'), 'key leaked into the event');
  const parsed = JSON.parse(body) as {
    event: string;
    distinct_id: string;
    properties: Record<string, unknown>;
  };
  assert.equal(parsed.event, 'runpod_mcp_tool_call');
  assert.equal(parsed.distinct_id, analyticsCallerId('rpa_SECRETKEY'));
  assert.match(parsed.distinct_id, /^k:[0-9a-f]{16}$/);
  assert.equal(parsed.properties.$process_person_profile, false);
  assert.equal(parsed.properties.tool, 'get-pod');
  // Stability: the same key maps to the same id (per-user frequency), and a
  // different key maps elsewhere (no collisions by construction).
  assert.equal(analyticsCallerId('rpa_SECRETKEY'), parsed.distinct_id);
  assert.notEqual(analyticsCallerId('rpa_OTHER'), parsed.distinct_id);
});

test('the event schema is the closed allowlist — no argument-shaped fields', () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  captureToolCall('rpa_k', EVENT);
  const props = (
    JSON.parse(captured[0].body) as { properties: Record<string, unknown> }
  ).properties;
  assert.deepEqual(Object.keys(props).sort(), [
    '$process_person_profile',
    'client_name',
    'duration_ms',
    'ok',
    'server_version',
    'status',
    'surface_version',
    'tool',
    'transport',
  ]);
});

test('the tool surface is recorded as profile', () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  captureToolCall('rpa_k', { ...EVENT, profile: 'directory' });
  const props = (
    JSON.parse(captured[0].body) as { properties: Record<string, unknown> }
  ).properties;
  assert.equal(props.profile, 'directory');
});

test('a capture failure never propagates', () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  assert.doesNotThrow(() => captureToolCall('rpa_k', EVENT));
});

test('the account id is the preferred identity and survives key rotation', () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  process.env.MCP_ANALYTICS_SALT = 'salt-1';
  const beforeRotation = analyticsCallerId('rpa_OLDKEY', 'user_123');
  const afterRotation = analyticsCallerId('rpa_NEWKEY', 'user_123');
  assert.equal(beforeRotation, afterRotation, 'same account must keep one id');
  assert.match(beforeRotation, /^a:[0-9a-f]{16}$/);
  assert.ok(!beforeRotation.includes('user_123'), 'raw account id leaked');
  // And the raw account id never appears in a captured payload either.
  captureToolCall('rpa_NEWKEY', { ...EVENT, accountId: 'user_123' });
  assert.ok(!captured[0].body.includes('user_123'));
  assert.equal(
    (JSON.parse(captured[0].body) as { distinct_id: string }).distinct_id,
    afterRotation
  );
});

type Captured = { event: string; properties: Record<string, unknown> };
// Only the PostHog captures: a tool call may also hit the (mocked) API.
const events = (): Captured[] =>
  captured
    .filter(({ url }) => url.endsWith('/capture/'))
    .map(({ body }) => JSON.parse(body) as Captured);

test('only allowlisted, scalar argument values are recorded, bounded in length', () => {
  assert.equal(recordedArgumentValues(undefined, { id: 'x' }), undefined);
  assert.equal(recordedArgumentValues(['id'], {}), undefined);
  assert.deepEqual(
    recordedArgumentValues(['id', 'limit', 'nested'], {
      id: '  runpod-usage/storage ',
      limit: 5,
      nested: { secret: 'rpa_x' },
      other: 'dropped',
    }),
    { id: 'runpod-usage/storage', limit: '5' }
  );
  const long = recordedArgumentValues(['query'], { query: 'a'.repeat(500) });
  assert.equal(long?.query.length, 200);
});

test('recorded arguments are sent as arg_<name> properties', () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  captureToolCall('rpa_k', {
    ...EVENT,
    tool: 'read-guide',
    args: { id: 'golden-path/06-dev-pod' },
  });
  assert.equal(events()[0].properties.arg_id, 'golden-path/06-dev-pod');
});

test('resource events carry the method and uri, never the key', () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  captureResourceCall('rpa_SECRETKEY', {
    method: 'resources/read',
    uri: 'runpod://guides/runpod-mcp',
    ok: true,
    transport: 'http',
    serverVersion: '4.0.0',
  });
  assert.ok(!captured[0].body.includes('rpa_SECRETKEY'));
  const [event] = events();
  assert.equal(event.event, 'runpod_mcp_resource_call');
  assert.deepEqual(Object.keys(event.properties).sort(), [
    '$process_person_profile',
    'method',
    'ok',
    'server_version',
    'surface_version',
    'transport',
    'uri',
  ]);
});

async function connect(analytics: boolean) {
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test',
    analytics ? { analytics: { transport: 'http', serverVersion: 'test' } } : {}
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test('the server records guide and concept arguments on hosted tool calls', async () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  const client = await connect(true);
  await client.callTool({
    name: 'read-guide',
    arguments: { id: 'runpod-mcp' },
  });
  await client.callTool({
    name: 'search-concepts',
    arguments: { query: 'network volume', limit: 3 },
  });
  const [readGuide, search] = events();
  assert.equal(readGuide.properties.tool, 'read-guide');
  assert.equal(readGuide.properties.arg_id, 'runpod-mcp');
  assert.equal(readGuide.properties.guide_kind, 'skill');
  assert.equal(search.properties.guide_kind, undefined);
  assert.equal(search.properties.arg_query, 'network volume');
  assert.equal(search.properties.arg_limit, '3');
});

test('tools without recordedArguments still send no argument fields', async () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  const client = await connect(true);
  await client.callTool({ name: 'get-pod', arguments: { id: 'pod_123' } });
  const [event] = events();
  assert.equal(event.properties.tool, 'get-pod');
  assert.ok(!JSON.stringify(event).includes('pod_123'), 'resource id leaked');
  assert.ok(!Object.keys(event.properties).some((k) => k.startsWith('arg_')));
});

test('the server records resource reads only, with misses as unknown', async () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  const client = await connect(true);
  await client.listResources();
  await client.readResource({ uri: 'runpod://guides/runpod-mcp' });
  await assert.rejects(
    client.readResource({ uri: 'runpod://guides/not-a-guide?x=hello' })
  );
  assert.deepEqual(
    events().map(({ properties: p }) => [p.method, p.uri, p.ok]),
    [
      ['resources/read', 'runpod://guides/runpod-mcp', true],
      ['resources/read', 'unknown', false],
    ]
  );
});

test('an unknown read-guide id records no guide_kind', async () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  const client = await connect(true);
  await client.callTool({ name: 'read-guide', arguments: { id: 'nope' } });
  const [event] = events();
  assert.equal(event.properties.arg_id, 'nope');
  assert.equal(event.properties.guide_kind, undefined);
});

test('without the analytics option (stdio) resource requests send nothing', async () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  const client = await connect(false);
  await client.listResources();
  await client.readResource({ uri: 'runpod://guides/runpod-mcp' });
  assert.equal(captured.length, 0);
});

test('a rate-limited call is still captured, as a 429', async () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test',
    {
      analytics: { transport: 'http', serverVersion: 'test' },
      rateLimiter: async () => ({ allowed: false, retryAfterS: 30 }),
    }
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const result = await client.callTool({
    name: 'get-pod',
    arguments: { id: 'pod_123' },
  });
  assert.equal(result.isError, true);
  const [event] = events();
  assert.equal(event.properties.tool, 'get-pod');
  assert.equal(event.properties.status, 429);
  assert.equal(event.properties.ok, false);
  // A generic denial carries no reason, so it is not labeled as the breaker.
  assert.equal(event.properties.blocked_by, undefined);
});

test('a loop-breaker denial is labeled blocked_by', async () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test',
    {
      analytics: { transport: 'http', serverVersion: 'test' },
      rateLimiter: async () => ({
        allowed: false,
        retryAfterS: 60,
        reason: 'not_found_loop',
      }),
    }
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({ name: 'get-pod', arguments: { id: 'pod_123' } });
  assert.equal(events()[0].properties.blocked_by, 'not_found_loop');
});

test('the loop-blocked event carries the tool and block length, never the key', () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  captureLoopBlocked('rpa_SECRETKEY', {
    tool: 'get-pod',
    blockedForS: 3600,
    transport: 'http',
    serverVersion: '4.0.0',
    clientName: 'Python-urllib_3.12',
    accountId: 'user_123',
  });
  assert.ok(!captured[0].body.includes('rpa_SECRETKEY'));
  assert.ok(!captured[0].body.includes('user_123'));
  const [event] = events();
  assert.equal(event.event, 'runpod_mcp_loop_blocked');
  assert.deepEqual(Object.keys(event.properties).sort(), [
    '$process_person_profile',
    'blocked_for_s',
    'client_name',
    'server_version',
    'surface_version',
    'tool',
    'transport',
  ]);
});
