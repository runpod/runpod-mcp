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
