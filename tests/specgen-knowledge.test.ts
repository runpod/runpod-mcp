// Knowledge tools and guide resources, served from the @runpod/plugin-knowledge bundle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadKnowledge } from '@runpod/plugin-knowledge';
import { createToolContext } from '#src/specgen/context';

// The knowledge tools read KNOWLEDGE_HIDDEN_RULES once at load, so it is set
// before the server is imported, and the warnings of that load are kept. The
// second id is in no bundle.
const HIDDEN_RULE = 'pod.running-is-not-ready';
const UNKNOWN_RULE = 'pod.no-such-rule';
process.env.KNOWLEDGE_HIDDEN_RULES = ` ${HIDDEN_RULE} ,${UNKNOWN_RULE},`;
const loadWarnings: unknown[][] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  loadWarnings.push(args);
};
const { createSpecgenServer } = await import('#src/specgen/server').finally(
  () => {
    console.warn = originalWarn;
  }
);

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
  // Other concepts' rules about network volumes (file transfer, VolumeCache)
  // may rank here too; each hit must still be about a network volume.
  assert.equal(body.count, 3);
  assert.ok(
    body.rules.every(
      (rule: { concept: string; statement: string }) =>
        rule.concept.startsWith('network-volume') ||
        /network[- ]volume/i.test(rule.statement)
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

test('a rule in KNOWLEDGE_HIDDEN_RULES is left out of both concept tools and every citation of it', async () => {
  const bundle = loadKnowledge();
  const concept = (id: string) =>
    bundle.concepts.find((candidate) => candidate.id === id)!;
  const hidden = concept('pod').rules.find((rule) => rule.id === HIDDEN_RULE);
  assert.ok(hidden, `${HIDDEN_RULE} is a pod rule in the bundle`);
  // The bundle cites it from another concept's rule, a step and a doc.
  assert.ok(
    concept('exposed-port').rules.some((rule) => rule.see.includes(HIDDEN_RULE))
  );
  assert.ok(
    concept('pod-deployment').steps.some((step) =>
      step.rules.includes(HIDDEN_RULE)
    )
  );
  assert.ok(
    bundle.links.some(
      (link) => link.to === 'pod' && link.rules?.includes(HIDDEN_RULE)
    )
  );
  const client = await connect();
  try {
    for (const id of ['pod', 'exposed-port', 'pod-deployment']) {
      const { body } = await call(client, 'lookup-concept', { concept: id });
      assert.equal(body.id, id);
      assert.ok(
        !JSON.stringify(body).includes(HIDDEN_RULE),
        `lookup-concept ${id} mentions the hidden rule`
      );
    }
    const search = await call(client, 'search-concepts', {
      query: hidden.statement,
      limit: 25,
    });
    assert.ok(search.body.count > 0);
    assert.ok(
      search.body.rules.every((rule: { id: string }) => rule.id !== HIDDEN_RULE)
    );
  } finally {
    await client.close();
  }
});

test('an id in KNOWLEDGE_HIDDEN_RULES that the bundle does not hold is warned about at load', () => {
  assert.deepEqual(
    loadWarnings.filter(([event]) => event === 'knowledge_hidden_rule_unknown'),
    [
      [
        'knowledge_hidden_rule_unknown',
        { id: UNKNOWN_RULE, plugin_version: loadKnowledge().version },
      ],
    ]
  );
});

test('a rule with conflict set comes back flagged from both concept tools', async () => {
  // The bundle may have no disputed rule, so one is flagged on the bundle the
  // tools serve.
  const rule = loadKnowledge().concepts.find(
    (concept) => concept.id === 'machine'
  )!.rules[0]!;
  const saved = rule.conflict;
  const client = await connect();
  rule.conflict = true;
  try {
    const byId = (rules: { id: string; conflict: boolean }[]) =>
      rules.find((candidate) => candidate.id === rule.id);
    const lookup = await call(client, 'lookup-concept', { concept: 'machine' });
    assert.equal(byId(lookup.body.rules)?.conflict, true);
    const search = await call(client, 'search-concepts', {
      query: rule.statement,
      limit: 25,
    });
    assert.equal(byId(search.body.rules)?.conflict, true, rule.id);
  } finally {
    rule.conflict = saved;
    await client.close();
  }
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
