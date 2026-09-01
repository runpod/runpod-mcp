// Skills served as MCP resources: list, read, unknown-uri error, and the
// instructions briefing that steers agents to load them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createSpecgenServer,
  SERVER_INSTRUCTIONS,
} from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';
import { skillDocs } from '../src/specgen/generated/skills.gen.js';

async function connect() {
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test'
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test('lists all ten skills as markdown resources', async () => {
  const client = await connect();
  const { resources } = await client.listResources();
  assert.equal(resources.length, 10);
  const router = resources.find((r) => r.uri === 'runpod://skills/runpod');
  assert.ok(router, 'router skill present');
  assert.equal(router.mimeType, 'text/markdown');
  assert.ok(router.description && router.description.length > 20);
  await client.close();
});

test('reads a skill body verbatim', async () => {
  const client = await connect();
  const res = await client.readResource({ uri: 'runpod://skills/pod-doctor' });
  const text = (res.contents[0] as { text: string }).text;
  assert.equal(text, skillDocs.find((s) => s.name === 'pod-doctor')!.text);
  assert.match(text, /Pod doctor/);
  await client.close();
});

test('unknown resource errors and names the available uris', async () => {
  const client = await connect();
  await assert.rejects(
    () => client.readResource({ uri: 'runpod://skills/nope' }),
    /runpod:\/\/skills\/runpod/
  );
  await client.close();
});

test('instructions direct agents to the router resource before acting', () => {
  assert.match(SERVER_INSTRUCTIONS, /runpod:\/\/skills\/runpod/);
  assert.match(SERVER_INSTRUCTIONS, /READ BEFORE ACTING/);
});

test('every embedded skill matches its on-disk source', async () => {
  const { readFileSync } = await import('node:fs');
  for (const skill of skillDocs) {
    assert.equal(
      skill.text,
      readFileSync(`specgen/skills/${skill.name}/SKILL.md`, 'utf8'),
      skill.name
    );
  }
});
