// The no-logging invariant: a tool call's log line carries no credential and
// no tool arguments, even when the arguments contain secrets.
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer } from '../src/specgen/server.js';
import type { ToolContext } from '../src/specgen/context.js';

test('tool-call log lines never contain the key or the arguments', async (t) => {
  const API_KEY = 'rpa_SUPER_SECRET_KEY_00000000000000000000000';
  const SECRET_ARG = 's3cr3t-payload-value';
  const lines: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => {
    lines.push(parts.map(String).join(' '));
  };
  t.after(() => {
    console.error = original;
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

test(
  'real stdio process keeps tool logs off the protocol stream',
  { timeout: 10_000 },
  async (t) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/stdio.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, RUNPOD_API_KEY: 'fake-stdio-test-key' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    t.after(async () => {
      child.kill();
      await closed;
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const send = (message: unknown) =>
      child.stdin.write(JSON.stringify(message) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });
    let receivedReply = false;
    const lines = createInterface({ input: child.stdout });
    t.after(() => lines.close());
    for await (const line of lines) {
      // Any operational log on stdout fails here, even if a tolerant client
      // could skip the malformed message and eventually read the real reply.
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
      if (message.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        // Unknown tool exercises dispatch + logging without any network call.
        send({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'unknown-test-tool',
            arguments: {},
          },
        });
      } else if (message.id === 2) {
        assert.equal(message.result.isError, true);
        receivedReply = true;
        break;
      }
    }
    assert.equal(receivedReply, true);
    child.kill();
    await closed;
    assert.match(stderr, /tool_call .*unknown-test-tool/);
    assert.ok(!stderr.includes('fake-stdio-test-key'));
  }
);
