// The plugin guides served as MCP resources: list, read, unknown-uri error, and
// the instructions briefing that steers agents to the runpod-mcp playbook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createSpecgenServer,
  SERVER_INSTRUCTIONS,
} from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';
import { guideResources } from '../src/specgen/tools/knowledge.js';

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

const JOURNEYS = [
  'runpod-mcp',
  'discovery',
  'lifecycle-crud',
  'serverless-deploy',
  'pod-deploy',
  'pod-doctor',
  'endpoint-ops',
  'cost-audit',
];

test('lists only the plugin guides, the journey playbooks among them', async () => {
  const client = await connect();
  const { resources } = await client.listResources();
  assert.equal(resources.length, guideResources.length);
  assert.ok(resources.every((r) => r.uri.startsWith('runpod://guides/')));
  for (const id of JOURNEYS) {
    const guide = resources.find((r) => r.uri === `runpod://guides/${id}`);
    assert.ok(guide, `${id} guide present`);
    assert.equal(guide.mimeType, 'text/markdown');
  }
  await client.close();
});

test('reads a journey guide body verbatim', async () => {
  const client = await connect();
  const uri = 'runpod://guides/pod-doctor';
  const res = await client.readResource({ uri });
  const text = (res.contents[0] as { text: string }).text;
  assert.equal(text, guideResources.find((g) => g.uri === uri)!.text);
  assert.match(text, /Pod doctor/);
  await client.close();
});

test('unknown resource errors and points at list-guides', async () => {
  const client = await connect();
  await assert.rejects(
    () => client.readResource({ uri: 'runpod://skills/runpod' }),
    /list-guides/
  );
  await client.close();
});

test('instructions direct agents to the runpod-mcp playbook before acting', () => {
  assert.match(SERVER_INSTRUCTIONS, /READ BEFORE ACTING/);
  assert.match(SERVER_INSTRUCTIONS, /read-guide runpod-mcp/);
  assert.match(SERVER_INSTRUCTIONS, /plugin's runpod-mcp skill/);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /runpod:\/\/skills\//);
});

// The plugin recommendation is worth pinning: a silent drop would leave agents
// with no way to learn the runpodctl/flash/golden-path lanes this server's
// resources deliberately omit. It names the repo rather than an install command
// on purpose — the command differs per client and the README there is current.
test('instructions point unequipped agents at the official plugin', () => {
  assert.match(SERVER_INSTRUCTIONS, /OFFICIAL RUNPOD PLUGIN/);
  assert.match(
    SERVER_INSTRUCTIONS,
    /github\.com\/runpod\/runpod-plugins-official/
  );
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
