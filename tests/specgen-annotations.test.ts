// Annotations are the only deterministic signal a host has for "does this need
// a human": a missing readOnlyHint makes delete-cluster look like list-pods.
// These gates cover both halves — set on the tool, and passed through
// tools/list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer, curatedTools } from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { knowledgeTools } from '#src/specgen/tools/knowledge';
import { DESCRIBE_TOOL_NAME } from '#src/specgen/on-demand';

// Tools that read nothing outside the server: the bundled plugin guides and
// the server's own tool table.
const localToolNames = new Set([
  ...knowledgeTools.map((tool) => tool.name),
  DESCRIBE_TOOL_NAME,
]);

async function listTools() {
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test',
    {
      alp: {
        ingestUrl: 'http://127.0.0.1:9/api/alp/submit',
        transport: 'stdio',
      },
      // Serve search-docs too, so every optional tool is classified. The
      // listing never calls it.
      search: () => Promise.reject(new Error('not called')),
    }
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

test('every tool reaches the client with its hints, idempotentHint false left out', async () => {
  const tools = await listTools();
  for (const tool of tools) {
    const annotations = tool.annotations;
    assert.ok(annotations, `${tool.name} must carry annotations`);
    for (const hint of [
      'readOnlyHint',
      'destructiveHint',
      'openWorldHint',
    ] as const) {
      assert.equal(
        typeof annotations[hint],
        'boolean',
        `${tool.name}.${hint} must be a boolean`
      );
    }
    // tools/list leaves out idempotentHint when false, its MCP spec default.
    assert.notEqual(
      annotations.idempotentHint,
      false,
      `${tool.name}.idempotentHint is false and must be left out`
    );
    assert.equal(annotations.openWorldHint, !localToolNames.has(tool.name));
    if (annotations.readOnlyHint)
      assert.equal(
        annotations.destructiveHint,
        false,
        `${tool.name} cannot be both read-only and destructive`
      );
  }
});

// The reviewed hints for every served tool, as readOnly / destructive /
// idempotent / openWorld (T or F). Pinned by name rather than derived from
// the HTTP method, because the method is what got these wrong: a PATCH that
// clears exclusions or restarts a container is not additive. A new tool fails
// here until someone decides its row.
const expectedHints = new Map<string, string>([
  ['ask_question', 'FFFT'],
  ['cancel-job', 'FTTT'],
  ['create-cluster', 'FFFT'],
  ['create-delegation', 'FFFT'],
  ['create-endpoint', 'FFFT'],
  ['create-global-volume', 'FFFT'],
  ['create-network-volume', 'FFFT'],
  ['create-pod', 'FFFT'],
  ['create-registry', 'FFFT'],
  ['create-secret', 'FFTT'],
  ['create-template', 'FFFT'],
  ['delete-cluster', 'FTTT'],
  ['delete-endpoint', 'FTTT'],
  ['delete-global-volume', 'FTTT'],
  ['delete-network-volume', 'FTTT'],
  ['delete-pod', 'FTTT'],
  ['delete-registry', 'FTTT'],
  ['delete-secret', 'FTTT'],
  ['delete-template', 'FTTT'],
  ['deploy-hub-repo', 'FFFT'],
  ['describe-tool', 'TFTF'],
  ['endpoint-health', 'TFTT'],
  ['get-capacity', 'TFTT'],
  ['get-cluster', 'TFTT'],
  ['get-cpu-type', 'TFTT'],
  ['get-data-center', 'TFTT'],
  ['get-endpoint', 'TFTT'],
  ['get-endpoint-build', 'TFTT'],
  ['get-global-volume', 'TFTT'],
  ['get-gpu-type', 'TFTT'],
  ['get-job-status', 'TFTT'],
  ['get-network-volume', 'TFTT'],
  ['get-organization', 'TFTT'],
  ['get-pod', 'TFTT'],
  ['get-registry', 'TFTT'],
  ['get-secret', 'TFTT'],
  ['get-ssh-keys', 'TFTT'],
  ['get-template', 'TFTT'],
  ['list-audit-logs', 'TFTT'],
  ['list-billing', 'TFTT'],
  ['list-cluster-billing', 'TFTT'],
  ['list-cluster-pods', 'TFTT'],
  ['list-clusters', 'TFTT'],
  ['list-cpu-types', 'TFTT'],
  ['list-data-centers', 'TFTT'],
  ['list-delegations', 'TFTT'],
  ['list-endpoint-billing', 'TFTT'],
  ['list-endpoint-builds', 'TFTT'],
  ['list-endpoint-releases', 'TFTT'],
  ['list-endpoint-workers', 'TFTT'],
  ['list-endpoints', 'TFTT'],
  ['list-global-volumes', 'TFTT'],
  ['list-gpu-types', 'TFTT'],
  ['list-guides', 'TFTF'],
  ['list-hub-repos', 'TFTT'],
  ['list-network-volume-billing', 'TFTT'],
  ['list-network-volumes', 'TFTT'],
  ['list-pod-billing', 'TFTT'],
  ['list-pods', 'TFTT'],
  ['list-public-endpoints', 'TFTT'],
  ['list-public-templates', 'TFTT'],
  ['list-registries', 'TFTT'],
  ['list-secrets', 'TFTT'],
  ['list-serverless-billing', 'TFTT'],
  ['list-templates', 'TFTT'],
  ['lookup-concept', 'TFTF'],
  ['pod-action', 'FTFT'],
  ['purge-endpoint-queue', 'FTTT'],
  ['read-guide', 'TFTF'],
  ['read_journal', 'TFTT'],
  ['report_feedback', 'FFFT'],
  ['report_how_user_found_runpod', 'FFTT'],
  ['retry-job', 'FTFT'],
  ['revoke-delegation', 'FTTT'],
  ['run-endpoint', 'FFFT'],
  ['runsync-endpoint', 'FFFT'],
  ['save_to_journal', 'FFFT'],
  ['search-concepts', 'TFTF'],
  ['search-docs', 'TFTT'],
  ['set-endpoint-gpus', 'FTTT'],
  ['stream-job', 'FTFT'],
  ['stream-pod-logs', 'TFTT'],
  ['stream-worker-logs', 'TFTT'],
  ['update-cluster', 'FFTT'],
  ['update-endpoint', 'FTFT'],
  ['update-global-volume', 'FFTT'],
  ['update-network-volume', 'FFTT'],
  ['update-pod', 'FTFT'],
  ['update-secret', 'FTFT'],
  ['update-ssh-keys', 'FTTT'],
  ['update-template', 'FTTT'],
]);

function hintsOf(annotations: {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}): string {
  return [
    annotations.readOnlyHint,
    annotations.destructiveHint,
    // tools/list omits idempotentHint when false.
    annotations.idempotentHint ?? false,
    annotations.openWorldHint,
  ]
    .map((hint) => (hint ? 'T' : 'F'))
    .join('');
}

test('every served tool carries its reviewed hints', async () => {
  const tools = await listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...expectedHints.keys()].sort(),
    'the served tool set changed: add or remove its row in expectedHints'
  );
  for (const tool of tools) {
    assert.equal(
      hintsOf(tool.annotations ?? {}),
      expectedHints.get(tool.name),
      tool.name
    );
  }
});

test('the generated definitions carry the same hints as tools/list', () => {
  for (const tool of [...generatedTools, ...curatedTools]) {
    assert.equal(
      hintsOf(tool.annotations),
      expectedHints.get(tool.name),
      tool.name
    );
  }
});
