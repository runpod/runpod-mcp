// Titles are the human-readable names hosts show in place of `list-gpu-types`,
// and directory reviews (Anthropic's connector directory among them) flag any
// tool without one. These gates cover the derivation and the full served
// surface, ALP and search-docs included.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer } from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';
import { titleFromName } from '#src/specgen/titles';

test('titleFromName uses sentence case and keeps proper nouns', () => {
  assert.equal(titleFromName('list-gpu-types'), 'List GPU types');
  assert.equal(titleFromName('create-pod'), 'Create Pod');
  assert.equal(titleFromName('list-cluster-pods'), 'List cluster Pods');
  assert.equal(titleFromName('get-ssh-keys'), 'Get SSH keys');
  assert.equal(
    titleFromName('list-serverless-billing'),
    'List Serverless billing'
  );
  assert.equal(titleFromName('save_to_journal'), 'Save to journal');
});

test('every served tool reaches the client with a distinct title', async () => {
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test',
    {
      alp: {
        ingestUrl: 'http://127.0.0.1:9/api/alp/submit',
        transport: 'stdio',
      },
      search: async () => ({ status: 200, body: {} as never }),
    }
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  await client.close();

  const seen = new Map<string, string>();
  for (const tool of tools) {
    const { name, title } = tool;
    assert.equal(typeof title, 'string', `${name} must carry a title`);
    assert.match(title!, /^[A-Z]/, `${name} title must start capitalized`);
    assert.doesNotMatch(
      title!,
      /[-_]/,
      `${name} title must read as words, not a tool name`
    );
    assert.ok(
      !seen.has(title!),
      `${name} and ${seen.get(title!)} share the title "${title}"`
    );
    seen.set(title!, name);
  }
});
