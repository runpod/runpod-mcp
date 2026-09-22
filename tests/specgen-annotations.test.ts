// Annotations are the only deterministic signal a host has for "does this need
// a human": a missing readOnlyHint makes delete-cluster look like list-pods.
// These gates cover both halves — set on the tool, and passed through
// tools/list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer, curatedTools } from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';
import { generatedTools } from '../src/specgen/generated/tools.gen.js';

async function listTools() {
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test',
    {
      alp: {
        ingestUrl: 'http://127.0.0.1:9/api/alp/submit',
        transport: 'stdio',
      },
    }
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

test('every tool reaches the client with a complete annotation set', async () => {
  const tools = await listTools();
  for (const tool of tools) {
    const annotations = tool.annotations;
    assert.ok(annotations, `${tool.name} must carry annotations`);
    for (const hint of [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ] as const) {
      assert.equal(
        typeof annotations[hint],
        'boolean',
        `${tool.name}.${hint} must be a boolean`
      );
    }
    assert.equal(annotations.openWorldHint, true);
    if (annotations.readOnlyHint)
      assert.equal(
        annotations.destructiveHint,
        false,
        `${tool.name} cannot be both read-only and destructive`
      );
  }
});

test('generated annotations follow the HTTP method they wrap', () => {
  for (const tool of generatedTools) {
    assert.equal(tool.annotations.readOnlyHint, tool.method === 'GET');
    assert.equal(tool.annotations.destructiveHint, tool.method === 'DELETE');
  }
  // The DELETE tools are the set a host most needs to gate.
  assert.deepEqual(
    generatedTools
      .filter((tool) => tool.annotations.destructiveHint)
      .map((tool) => tool.name),
    [
      'delete-cluster',
      'delete-endpoint',
      'delete-network-volume',
      'delete-pod',
      'delete-registry',
      'delete-secret',
      'delete-template',
      'revoke-delegation',
    ]
  );
});

test('the curated overlay marks its reads read-only and its teardowns destructive', () => {
  const byName = new Map(curatedTools.map((tool) => [tool.name, tool]));
  for (const name of ['list-endpoints', 'list-templates', 'get-job-status']) {
    assert.equal(byName.get(name)!.annotations.readOnlyHint, true, name);
  }
  for (const name of ['cancel-job', 'purge-endpoint-queue']) {
    assert.equal(byName.get(name)!.annotations.destructiveHint, true, name);
    assert.equal(byName.get(name)!.annotations.readOnlyHint, false, name);
  }
  for (const name of ['run-endpoint', 'runsync-endpoint', 'deploy-hub-repo']) {
    assert.equal(byName.get(name)!.annotations.readOnlyHint, false, name);
    assert.equal(byName.get(name)!.annotations.destructiveHint, false, name);
  }
});
