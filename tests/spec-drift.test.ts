import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operations, type OpenApiSpec } from '../scripts/spec-drift.js';

function fixture() {
  return {
    paths: {
      '/pods': {
        parameters: [{ $ref: '#/components/parameters/Region' }],
        post: {
          operationId: 'createPod',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Pod' },
              },
            },
          },
        },
      },
    },
    components: {
      parameters: {
        Region: { name: 'region', in: 'query', schema: { type: 'string' } },
      },
      schemas: {
        Pod: {
          type: 'object',
          properties: { gpu: { $ref: '#/components/schemas/Gpu' } },
        },
        Gpu: {
          type: 'object',
          properties: {
            count: { type: 'integer', minimum: 1 },
            next: { $ref: '#/components/schemas/Gpu' },
          },
        },
        Unused: { type: 'string' },
      },
    },
  };
}

test('input fingerprints detect nested schema, body and path-parameter changes', () => {
  const before = operations(fixture()).get('createPod')!;
  const edits: Array<(spec: ReturnType<typeof fixture>) => void> = [
    (spec) => {
      Object.assign(spec.components.schemas.Pod, { required: ['gpu'] });
    },
    (spec) => {
      spec.components.schemas.Gpu.properties.count.minimum = 2;
    },
    (spec) => {
      Object.assign(spec.components.parameters.Region.schema, { enum: ['EU'] });
    },
    (spec) => {
      Object.assign(spec.components.parameters.Region, {
        required: true,
        explode: false,
      });
    },
    (spec) => {
      spec.paths['/pods'].post.requestBody.required = false;
    },
  ];
  for (const edit of edits) {
    const spec = fixture();
    edit(spec);
    const after = operations(spec).get('createPod')!;
    assert.equal(after.route, before.route);
    assert.notEqual(after.input, before.input);
  }
});

test('object order and unused components do not cause input drift; recursive refs terminate', () => {
  const spec = fixture();
  const original = operations(spec);
  spec.components.schemas.Unused.type = 'number';
  const reversed = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reversed);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([k, v]) => [k, reversed(v)])
      );
    return value;
  };
  assert.deepEqual(operations(reversed(spec) as OpenApiSpec), original);
});

test('route changes and added or removed operations remain detectable', () => {
  const spec: OpenApiSpec = fixture();
  const before = operations(spec);
  spec.paths['/new-pods'] = spec.paths['/pods'];
  delete spec.paths['/pods'];
  spec.paths['/new-pods'].get = { operationId: 'listPods' };
  const after = operations(spec);
  assert.notEqual(
    after.get('createPod')!.route,
    before.get('createPod')!.route
  );
  assert.equal(after.has('listPods'), true);
  delete spec.paths['/new-pods'].post;
  assert.equal(operations(spec).has('createPod'), false);
});

test('spec-check CLI distinguishes network failures from drift and invalid specs', async (t) => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const cwd = new URL('../', import.meta.url);
  const spec = parse(
    readFileSync(new URL('specgen/spec/openapi.yaml', cwd), 'utf8')
  );
  for (const mode of ['reset', 'partial', '503', 'match', 'drift', 'invalid']) {
    await t.test(mode, async () => {
      const server = createServer((req, res) => {
        if (mode === 'reset') {
          req.socket.destroy();
        } else if (mode === 'partial') {
          res.writeHead(200, { 'Content-Length': '1000000' });
          res.write('{"paths":');
          setTimeout(() => res.destroy(), 30);
        } else if (mode === '503') {
          res.writeHead(503).end('unavailable');
        } else {
          res.end(
            mode === 'match'
              ? JSON.stringify(spec)
              : mode === 'drift'
                ? '{"paths":{}}'
                : 'invalid JSON'
          );
        }
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      try {
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'scripts/check-spec-drift.ts'],
          {
            cwd,
            env: {
              ...process.env,
              SPEC_URL: `http://127.0.0.1:${address.port}`,
            },
            timeout: 10000,
          }
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.stdout.resume();
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        const unavailable = ['reset', 'partial', '503'].includes(mode);
        assert.equal(code, unavailable ? 2 : mode === 'match' ? 0 : 1, stderr);
        if (unavailable) assert.match(stderr, /cannot judge drift/);
        if (mode === 'drift') assert.match(stderr, /out of date/);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    });
  }
});
