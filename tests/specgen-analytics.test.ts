// Privacy contract for the PostHog analytics helper: off by default, opt-out
// honored, and the captured payload never contains the key or arguments.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureToolCall,
  analyticsCallerId,
} from '../src/specgen/analytics.js';

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
  assert.equal(parsed.event, 'mcp_tool_call');
  assert.equal(parsed.distinct_id, analyticsCallerId('rpa_SECRETKEY'));
  assert.equal(parsed.distinct_id.length, 16);
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
    'tool',
    'transport',
  ]);
});

test('a capture failure never propagates', () => {
  process.env.POSTHOG_API_KEY = 'phc_test';
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  assert.doesNotThrow(() => captureToolCall('rpa_k', EVENT));
});
