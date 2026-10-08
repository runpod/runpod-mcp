// Knowledge tools and guide resources, served from the @runpod/plugin-knowledge bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadKnowledge } from '@runpod/plugin-knowledge';
import { createSpecgenServer } from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';

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

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return { isError: result.isError === true, body: JSON.parse(text) };
}

test('the four knowledge tools are listed', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  for (const name of [
    'list-guides',
    'read-guide',
    'lookup-concept',
    'search-concepts',
  ]) {
    assert.ok(
      tools.some((tool) => tool.name === name),
      name
    );
  }
  await client.close();
});

test('list-guides filters by kind and read-guide returns the body', async () => {
  const client = await connect();
  const { body } = await call(client, 'list-guides', { kind: 'golden-path' });
  assert.ok(body.count > 20);
  assert.ok(
    body.guides.every((guide: { kind: string }) => guide.kind === 'golden-path')
  );
  const dev = await call(client, 'read-guide', {
    id: 'golden-path/06-dev-pod',
  });
  assert.equal(dev.isError, false);
  assert.match(dev.body.body, /dev pod/i);
  assert.equal(dev.body.needs_shell, true);
  assert.equal(dev.body.parent, 'runpod');
  const missing = await call(client, 'read-guide', { id: '06-dev-pod' });
  assert.equal(missing.isError, true);
  assert.match(missing.body.hint, /golden-path\/06-dev-pod/);
  await client.close();
});

test('lookup-concept resolves aliases and reports what points at it', async () => {
  const client = await connect();
  const { body } = await call(client, 'lookup-concept', { concept: 'Machine' });
  assert.equal(body.id, 'machine');
  assert.ok(body.rules.length > 0);
  assert.ok(
    body.pointed_at_by.some(
      (edge: { concept: string }) => edge.concept === 'pod'
    )
  );
  const missing = await call(client, 'lookup-concept', {
    concept: 'nothing-like-this',
  });
  assert.equal(missing.isError, true);
  await client.close();
});

test('lookup-concept tolerates case, plurals and small typos', async () => {
  const client = await connect();
  const exact = await call(client, 'lookup-concept', { concept: 'POD' });
  assert.equal(exact.body.id, 'pod');
  assert.equal(exact.body.matched_as, undefined);
  for (const [concept, id] of [
    ['pods', 'pod'],
    ['Network Volumes', 'network-volume'],
    ['netwrk volume', 'network-volume'],
    ['serverles endpoint', 'serverless-endpoint'],
  ]) {
    const { body } = await call(client, 'lookup-concept', { concept });
    assert.equal(body.id, id, concept);
    assert.ok(body.matched_as, `${concept} reports matched_as`);
  }
  await client.close();
});

test('search-concepts matches plurals and one-letter typos', async () => {
  const client = await connect();
  const { body } = await call(client, 'search-concepts', {
    query: 'netwrk volumes',
    limit: 3,
  });
  assert.ok(
    body.rules.every((rule: { concept: string }) =>
      rule.concept.startsWith('network-volume')
    ),
    body.rules.map((rule: { id: string }) => rule.id).join(', ')
  );
  await client.close();
});

test('search-concepts ranks the restart rule for a restart question', async () => {
  const client = await connect();
  const { body } = await call(client, 'search-concepts', {
    query: 'why can my stopped pod not restart with a gpu',
    limit: 5,
  });
  const ids = body.rules.map((rule: { id: string }) => rule.id);
  assert.ok(
    ids.some(
      (id: string) =>
        id.startsWith('pod-deployment.') || id === 'pod.stopped-pod-keeps-host'
    ),
    ids.join(', ')
  );
  await client.close();
});

test('guides are also served as resources', async () => {
  const client = await connect();
  const { resources } = await client.listResources();
  const guides = resources.filter((r) => r.uri.startsWith('runpod://guides/'));
  assert.equal(guides.length, loadKnowledge().guides.length);
  const res = await client.readResource({
    uri: 'runpod://guides/runpod-usage/storage',
  });
  assert.match((res.contents[0] as { text: string }).text, /network volume/i);
  await client.close();
});

test('lookup-concept lists linked examples and docs, and list-guides filters by concept', async () => {
  const client = await connect();
  const { body } = await call(client, 'lookup-concept', {
    concept: 'network-volume',
  });
  const examples = body.examples.map((example: { id: string }) => example.id);
  assert.ok(
    examples.includes('golden-path/21-storage-tiers'),
    examples.join(', ')
  );
  assert.equal(
    body.examples.find(
      (example: { id: string }) => example.id === 'golden-path/21-storage-tiers'
    ).mcp,
    'full'
  );
  assert.ok(
    body.docs.some((doc: { id: string }) => doc.id === 'runpod-usage/storage')
  );

  const listed = await call(client, 'list-guides', {
    concept: 'network-volume',
    kind: 'golden-path',
  });
  assert.ok(
    listed.body.guides.every((guide: { concepts: string[] }) =>
      guide.concepts.includes('network-volume')
    )
  );
  assert.ok(listed.body.count >= examples.length);
  await client.close();
});
