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

// The plugin recommendation is worth pinning: a silent drop would leave agents
// with no way to learn the runpodctl/flash/golden-path lanes this server's
// resources deliberately omit. It names the repo rather than an install command
// on purpose — the command differs per client and the README there is current.
test('instructions point unequipped agents at the official plugin', () => {
  assert.match(SERVER_INSTRUCTIONS, /OFFICIAL RUNPOD PLUGIN/);
  assert.match(SERVER_INSTRUCTIONS, /github\.com\/runpod\/runpod-plugins-official/);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /plugin marketplace add/);
  // And that the precedence runs the right way: the server owns its own tool
  // surface even when the plugin's (necessarily lagging) tool list disagrees.
  assert.match(SERVER_INSTRUCTIONS, /source of truth for its OWN tool surface/);
});

// A client caches tools/list at connect, so a release or an alias move leaves it
// validating against a schema the server no longer serves. One production
// report burned a session retrying flat v1 arguments at a body-shaped
// create-pod. The briefing has to name refresh as the recovery, because
// retrying the same shape never converges.
test('instructions name refreshing the tool list as the fix for a shape rejection', () => {
  assert.match(SERVER_INSTRUCTIONS, /snapshot from when you connected/);
  assert.match(SERVER_INSTRUCTIONS, /refresh the tool list/);
});

test('every embedded skill matches its on-disk source', async () => {
  const { readFileSync } = await import('node:fs');
  // Normalize line endings: git checks the sources out with CRLF on Windows,
  // while the embedded text was generated from an LF checkout.
  const lf = (text: string) => text.replace(/\r\n/g, '\n');
  for (const skill of skillDocs) {
    assert.equal(
      lf(skill.text),
      lf(readFileSync(`specgen/skills/${skill.name}/SKILL.md`, 'utf8')),
      skill.name
    );
  }
});
