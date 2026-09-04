// The no-logging invariant: a tool call's log line carries no credential and
// no tool arguments, even when the arguments contain secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer } from '../src/specgen/server.js';
import type { ToolContext } from '../src/specgen/context.js';

test('tool-call log lines never contain the key or the arguments', async (t) => {
  const API_KEY = 'rpa_SUPER_SECRET_KEY_00000000000000000000000';
  const SECRET_ARG = 's3cr3t-payload-value';
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '));
  };
  t.after(() => {
    console.log = original;
  });

  const ctx = {
    apiKey: API_KEY,
    runtime: async () => ({ id: 'job-1', status: 'IN_QUEUE' }),
  } as unknown as ToolContext;
  const server = createSpecgenServer(ctx, 'test');
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({
    name: 'run-endpoint',
    arguments: { endpointId: 'ep123', input: { password: SECRET_ARG } },
  });
  await client.close();

  const toolLines = lines.filter((l) => l.startsWith('tool_call'));
  assert.ok(toolLines.length >= 1, 'a tool_call line was logged');
  for (const line of lines) {
    assert.ok(!line.includes(API_KEY), `log leaked the key: ${line}`);
    assert.ok(!line.includes(SECRET_ARG), `log leaked an argument: ${line}`);
  }
  const entry = JSON.parse(toolLines[0].replace(/^tool_call /, ''));
  assert.equal(entry.tool, 'run-endpoint');
  assert.equal(entry.ok, true);
  assert.match(entry.caller, /^[0-9a-f]{12}$/);
});
