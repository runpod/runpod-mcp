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

// A spec-declared `explode: false` query param must reach the API as ONE
// comma-joined value. openapi-fetch's default serializer repeats the key per
// array item, and upstream rejects that outright ("parameter 'regions' is not
// exploded, but is specified multiple times"). Found by hand against the
// preview on 2026-09-08: single-value filters passed, multi-value ones 400'd,
// which is the shape of bug that survives casual testing.
//
// Asserted on the outgoing REQUEST URL, not on the query object dispatch hands
// the SDK. The bug was never in our string — it was in how openapi-fetch
// serialized it — so stubbing the client out would test the input to the
// component that was broken and take the rest on faith. Running the real
// client against a stub fetch tests the wire format that actually 400'd, and
// getAll() proves there is exactly ONE param rather than two.
test('non-exploded array query params are comma-joined, not repeated', async () => {
  const { createRunpodClient } = await import('@runpod/sdk');
  const { generatedTools } = await import(
    '../src/specgen/generated/tools.gen.js'
  );
  const { dispatchGeneratedTool } = await import('../src/specgen/dispatch.js');

  const seen: Request[] = [];
  const client = createRunpodClient({
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    retry: false,
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const dcs = generatedTools.find((t) => t.name === 'list-data-centers')!;
  assert.equal(
    dcs.params.find((p) => p.name === 'regions')?.explode,
    false,
    'regions must be marked non-exploded'
  );

  const multi = await dispatchGeneratedTool(client, dcs, {
    regions: ['EUROPE', 'ASIA'],
    compliance: ['GDPR', 'HIPAA'],
  });
  assert.equal(multi.ok, true);
  const q = new URL(seen[0].url).searchParams;
  assert.deepEqual(q.getAll('regions'), ['EUROPE,ASIA']);
  assert.deepEqual(q.getAll('compliance'), ['GDPR,HIPAA']);

  // A single-element array must serialize the same way — no special case.
  await dispatchGeneratedTool(client, dcs, { regions: ['EUROPE'] });
  assert.deepEqual(new URL(seen[1].url).searchParams.getAll('regions'), [
    'EUROPE',
  ]);

  // A non-array value is untouched.
  await dispatchGeneratedTool(client, dcs, { globalNetwork: true });
  assert.equal(new URL(seen[2].url).searchParams.get('globalNetwork'), 'true');
});

// The mirror of the missing-required gate. A plausible-but-wrong argument name
// used to be dropped in silence: `includeAvailability` is the v1 spelling of
// what v2 calls `include=AVAILABILITY`, and sending it returned a cheerful 200
// with no availability fields, which reads as a priced, in-stock answer. Found
// by hand against the preview during the 2026-09-08 read-tier pass.
test('dispatch 400s an unknown argument instead of dropping it', async () => {
  const { dispatchGeneratedTool } = await import('../src/specgen/dispatch.js');
  const tool = generatedTools.find((t) => t.name === 'list-gpu-types')!;
  const boom = new Proxy(
    {},
    {
      get() {
        throw new Error('API must not be called');
      },
    }
  );
  const result = await dispatchGeneratedTool(boom as never, tool, {
    includeAvailability: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  const body = JSON.stringify(result.payload);
  assert.match(body, /Unknown argument: includeAvailability/);
  // The error has to name the real parameter, or the agent just guesses again.
  assert.match(body, /"include"/);
  assert.match(body, /"product"/);
});

// A body-carrying tool must still accept `body`, which is not a declared param.
test('the body argument is not mistaken for an unknown one', async () => {
  const { dispatchGeneratedTool } = await import('../src/specgen/dispatch.js');
  const tool = generatedTools.find((t) => t.name === 'create-pod')!;
  assert.equal(tool.hasBody, true, 'create-pod must carry a body');
  const seen: string[] = [];
  const client = {
    POST: async (path: string, init: Record<string, unknown>) => {
      seen.push(path);
      assert.ok(init.body, 'body must reach the client');
      return { data: { id: 'pod_1' }, response: new Response('{}') };
    },
  };
  const result = await dispatchGeneratedTool(client as never, tool, {
    body: { name: 'x', imageName: 'y' },
  });
  assert.equal(result.ok, true, JSON.stringify(result.payload));
  assert.equal(seen.length, 1);
});

// Some MCP clients hand a nested object argument over as a JSON string. That
// used to reach upstream verbatim and come back as "$: got string, want
// object", which never says the body was stringified — so the agent re-reads
// the schema it already followed. Found by hand: it blocked every
// body-carrying tool from the Claude Code client during the write-tier pass.
test('a stringified JSON body is parsed, not forwarded as a string', async () => {
  const { dispatchGeneratedTool } = await import('../src/specgen/dispatch.js');
  const tool = generatedTools.find((t) => t.name === 'create-pod')!;
  const seen: unknown[] = [];
  const client = {
    POST: async (_p: string, init: Record<string, unknown>) => {
      seen.push(init.body);
      return { data: { id: 'pod_1' }, response: new Response('{}') };
    },
  };
  const result = await dispatchGeneratedTool(client as never, tool, {
    body: JSON.stringify({ name: 'x', image: 'y', gpu: { count: 1 } }),
  });
  assert.equal(result.ok, true, JSON.stringify(result.payload));
  assert.deepEqual(seen[0], { name: 'x', image: 'y', gpu: { count: 1 } });
});

test('a body string that is not JSON is a named 400, not an upstream 422', async () => {
  const { dispatchGeneratedTool } = await import('../src/specgen/dispatch.js');
  const tool = generatedTools.find((t) => t.name === 'create-pod')!;
  const boom = new Proxy(
    {},
    {
      get() {
        throw new Error('API must not be called');
      },
    }
  );
  const result = await dispatchGeneratedTool(boom as never, tool, {
    body: 'not json at all',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(JSON.stringify(result.payload), /not valid JSON/);
});

test('generation freshness check rejects stale schemas and config without writing output', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { stringify } = await import('yaml');
  const temp = mkdtempSync(join(tmpdir(), 'mcp-generation-check-'));
  const generator = fileURLToPath(
    new URL('../specgen/generator/generate-tools.ts', import.meta.url)
  );
  // `--import` takes a URL or bare specifier, not a path. The bare 'tsx' the
  // stdio test uses would not resolve from the temp cwd, so resolve it here —
  // and hand it over as file:// : on Windows an absolute path parses as URL
  // scheme "d:" and Node refuses it (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  const loader = pathToFileURL(
    createRequire(import.meta.url).resolve('tsx')
  ).href;
  const check = () =>
    spawnSync(process.execPath, ['--import', loader, generator, '--check'], {
      cwd: temp,
      encoding: 'utf8',
      timeout: 10000,
    });
  try {
    mkdirSync(join(temp, 'specgen/spec'), { recursive: true });
    writeFileSync(join(temp, 'specgen/spec/openapi.yaml'), stringify(spec));
    writeFileSync(
      join(temp, 'specgen/generator-config.yaml'),
      stringify(config)
    );
    const unchanged = check();
    assert.equal(unchanged.status, 0, unchanged.stderr);
    const changed = structuredClone(spec);
    changed.paths['/v2/pods/{id}'].get.parameters = [
      {
        in: 'query',
        name: 'newRequiredFilter',
        required: true,
        schema: { type: 'string' },
      },
    ];
    writeFileSync(join(temp, 'specgen/spec/openapi.yaml'), stringify(changed));
    const staleSchema = check();
    assert.equal(staleSchema.status, 1, staleSchema.stderr);
    assert.match(staleSchema.stderr, /Generated tools are stale/);
    writeFileSync(join(temp, 'specgen/spec/openapi.yaml'), stringify(spec));
    const changedConfig = structuredClone(config);
    changedConfig.rename.getPod = 'renamed-get-pod';
    writeFileSync(
      join(temp, 'specgen/generator-config.yaml'),
      stringify(changedConfig)
    );
    const staleConfig = check();
    assert.equal(staleConfig.status, 1, staleConfig.stderr);
    assert.equal(
      existsSync(join(temp, 'src')),
      false,
      'check mode must not write generated output'
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
