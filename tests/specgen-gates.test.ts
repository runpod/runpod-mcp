// The specgen drift gates, ported from the specgen repo's vitest suite:
//  - spec parity: every OpenAPI operation is generated or explicitly excluded
//  - old-MCP parity: all 54 tools of the pre-specgen server map to a served tool
//  - schema gate: every inputSchema compiles as self-contained JSON Schema
//  - offline handshake: no key -> full tool list, and a call fails as a 401
//    tool result, never a crash
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { Ajv } from 'ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generatedTools } from '../src/specgen/generated/tools.gen.js';
import { curatedTools, createSpecgenServer } from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';

const spec = parse(readFileSync('specgen/spec/openapi.yaml', 'utf8'));
const config = parse(readFileSync('specgen/generator-config.yaml', 'utf8'));
const exclusions: Record<string, { replacedBy?: string; reason?: string }> =
  config.exclude ?? {};

const specOperationIds = new Set<string>();
for (const pathItem of Object.values(
  spec.paths as Record<string, Record<string, { operationId: string }>>
)) {
  for (const method of ['get', 'put', 'post', 'delete', 'patch']) {
    if (pathItem[method]) specOperationIds.add(pathItem[method].operationId);
  }
}

const servedNames = new Set(
  [...curatedTools, ...generatedTools].map((tool) => tool.name)
);

test('spec parity: every operation is generated or explicitly excluded', () => {
  const generatedIds = new Set(generatedTools.map((tool) => tool.operationId));
  for (const operationId of specOperationIds) {
    assert.ok(
      generatedIds.has(operationId) || operationId in exclusions,
      `operation ${operationId} is neither generated nor excluded`
    );
  }
  for (const tool of generatedTools) {
    assert.ok(specOperationIds.has(tool.operationId), tool.operationId);
  }
});

test('every exclusion states a reason; replacements are actually served', () => {
  for (const [operationId, exclusion] of Object.entries(exclusions)) {
    assert.ok(exclusion?.reason, `exclusion ${operationId} states no reason`);
    if (exclusion.replacedBy) {
      assert.ok(
        servedNames.has(exclusion.replacedBy),
        `exclusion ${operationId}: replacement ${exclusion.replacedBy} not served`
      );
    }
  }
});

test('no name collisions between curated and generated tools', () => {
  const names = [...curatedTools, ...generatedTools].map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
});

test('old-MCP parity: all mapped tools are served', () => {
  const manifest = parse(readFileSync('specgen/old-mcp-tools.yaml', 'utf8'));
  assert.equal(manifest.tools.length, 54);
  for (const entry of manifest.tools as Array<{ old: string; to: string }>) {
    assert.ok(
      servedNames.has(entry.to),
      `${entry.old} maps to unserved ${entry.to}`
    );
  }
});

test('every inputSchema compiles as a self-contained JSON Schema', () => {
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const tool of [...generatedTools, ...curatedTools]) {
    assert.doesNotThrow(
      () => ajv.compile(structuredClone(tool.inputSchema)),
      tool.name
    );
    assert.ok(tool.description.length > 10, `${tool.name} has no description`);
  }
  for (const tool of generatedTools) {
    assert.ok(
      !JSON.stringify(tool.inputSchema).includes('#/components/'),
      `${tool.name} leaks OpenAPI component refs`
    );
  }
});

test('offline handshake: keyless server lists 57 tools; a call 401s as a tool result', async (t) => {
  const saved = process.env.RUNPOD_API_KEY;
  delete process.env.RUNPOD_API_KEY;
  t.after(() => {
    if (saved !== undefined) process.env.RUNPOD_API_KEY = saved;
  });
  const server = createSpecgenServer(createToolContext(), 'test');
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  assert.equal(tools.length, generatedTools.length + curatedTools.length);
  assert.ok(tools.length >= 57, `surface shrank to ${tools.length}`);
  const res = (await client.callTool({ name: 'list-pods', arguments: {} })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /API key/i);
  await client.close();
});

test('dispatch 400s a missing required argument instead of calling the API', async () => {
  const { dispatchGeneratedTool } = await import('../src/specgen/dispatch.js');
  const tool = generatedTools.find((t) => t.name === 'get-gpu-type')!;
  const boom = new Proxy(
    {},
    {
      get() {
        throw new Error('API must not be called');
      },
    }
  );
  const result = await dispatchGeneratedTool(
    boom as never,
    tool,
    { gpuTypeId: 'stale-arg-name' } // the old name — must not silently vanish
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(JSON.stringify(result.payload), /Missing required argument.*id/);
});
