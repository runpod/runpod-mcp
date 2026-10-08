import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateTools,
  type SpecDocument,
} from '../specgen/generator/tools.js';

function bodySpec(schema: unknown): SpecDocument {
  return {
    paths: {
      '/v2/example': {
        post: {
          operationId: 'createExample',
          summary: 'Create a RunPod example',
          requestBody: {
            required: true,
            content: { 'application/json': { schema } },
          },
        },
      },
    },
  };
}

test('generation normalizes prose while preserving literal values and property names', () => {
  const literal = { description: 'RunPod', $ref: '#/components/schemas/Fake' };
  const body = {
    type: 'object',
    description: 'A RunPod resource',
    properties: {
      RunPod: {
        type: 'string',
        enum: ['RunPod', '#/components/schemas/Fake'],
        default: 'RunPod',
      },
      description: { type: 'string', description: 'RunPod text' },
      example: { type: 'object', description: 'RunPod data' },
    },
    examples: [literal],
    default: literal,
    const: literal,
  };
  const original = structuredClone(body);
  const [tool] = generateTools(bodySpec(body));
  assert.equal(tool.description, 'Create a Runpod example');
  assert.deepEqual(
    (tool.inputSchema.properties as Record<string, unknown>).body,
    {
      ...body,
      description: 'A Runpod resource',
      properties: {
        ...body.properties,
        description: { type: 'string', description: 'Runpod text' },
        example: { type: 'object', description: 'Runpod data' },
      },
    }
  );
  assert.equal(tool.inputSchema.$defs, undefined);
  assert.deepEqual(body, original, 'generation must not mutate its input');
});

test('references are rewritten structurally and collect transitive definitions once', () => {
  const spec = bodySpec({ $ref: '#/components/schemas/A~1B' });
  spec.components = {
    schemas: {
      'A/B': {
        type: 'object',
        properties: { child: { $ref: '#/components/schemas/Child' } },
      },
      Child: {
        anyOf: [{ $ref: '#/components/schemas/A~1B' }, { type: 'null' }],
      },
      Unused: { type: 'string' },
    },
  };
  const [tool] = generateTools(spec);
  assert.deepEqual(Object.keys(tool.inputSchema.$defs as object), [
    'A/B',
    'Child',
  ]);
  assert.deepEqual(
    (tool.inputSchema.properties as Record<string, unknown>).body,
    { $ref: '#/$defs/A~1B' }
  );
  assert.deepEqual(tool.inputSchema.$defs, {
    'A/B': { type: 'object', properties: { child: { $ref: '#/$defs/Child' } } },
    Child: { anyOf: [{ $ref: '#/$defs/A~1B' }, { type: 'null' }] },
  });
  assert.throws(
    () => generateTools(bodySpec({ $ref: '#/components/schemas/Missing' })),
    /Missing schema definition: Missing/
  );
});

test('operation parameters override inherited requirements and serialization', () => {
  const [tool] = generateTools({
    paths: {
      '/example/{id}': {
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            explode: false,
            schema: { type: 'array' },
          },
        ],
        get: {
          operationId: 'getExample',
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: false,
              schema: { type: 'string' },
            },
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
        },
      },
    },
  });
  assert.deepEqual(tool.inputSchema.required, ['id']);
  assert.deepEqual(tool.params, [
    { name: 'q', location: 'query' },
    { name: 'id', location: 'path' },
  ]);
  assert.deepEqual((tool.inputSchema.properties as Record<string, unknown>).q, {
    type: 'string',
  });
});

test('referenced request bodies retain requiredness and schema', () => {
  const spec = bodySpec({});
  spec.paths['/v2/example'].post!.requestBody = {
    $ref: '#/components/requestBodies/Input',
  };
  spec.components = {
    requestBodies: {
      Input: {
        required: true,
        content: { 'application/json': { schema: { type: 'string' } } },
      },
    },
  };
  const [tool] = generateTools(spec);
  assert.equal(tool.hasBody, true);
  assert.deepEqual(tool.inputSchema.required, ['body']);
  assert.deepEqual(tool.inputSchema.properties, { body: { type: 'string' } });
});

test('ambiguous flattened parameters fail generation instead of silently overwriting', () => {
  assert.throws(
    () =>
      generateTools({
        paths: {
          '/example/{id}': {
            get: {
              operationId: 'getExample',
              parameters: [
                { name: 'id', in: 'path', schema: { type: 'string' } },
                { name: 'id', in: 'query', schema: { type: 'number' } },
              ],
            },
          },
        },
      }),
    /Ambiguous parameter id/
  );
});

test('generation rejects stale exclusions and skips only known operations', () => {
  const spec = bodySpec({ type: 'object' });
  assert.throws(
    () =>
      generateTools(spec, {
        exclude: { oldCreateName: { reason: 'curated' } },
      }),
    /Excluded operations missing from spec: oldCreateName/
  );
  assert.deepEqual(
    generateTools(spec, {
      exclude: {
        createExample: { reason: 'curated', replacedBy: 'create-example' },
      },
    }),
    []
  );
});

test('annotation overrides merge over the method hints and reject stale keys', () => {
  const spec = bodySpec({ type: 'object' });
  assert.deepEqual(
    generateTools(spec, {
      annotations: { createExample: { destructiveHint: true } },
    })[0].annotations,
    {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    }
  );
  assert.throws(
    () =>
      generateTools(spec, {
        annotations: { oldCreateName: { destructiveHint: true } },
      }),
    /Annotated operations missing from spec: oldCreateName/
  );
});

test('unsupported parameter locations fail unless their operation is excluded', () => {
  for (const location of ['header', 'cookie']) {
    const spec = bodySpec({ type: 'object' });
    spec.paths['/v2/example'].post!.parameters = [
      { name: 'session', in: location, schema: { type: 'string' } },
    ];
    assert.throws(() => generateTools(spec), /Unsupported parameter location/);
    assert.deepEqual(
      generateTools(spec, {
        exclude: { createExample: { reason: 'curated transport' } },
      }),
      []
    );
  }
});
