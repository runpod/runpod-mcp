import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateTools,
  type SpecDocument,
} from '../specgen/generator/tools.js';
import { schemaViolations } from '#src/specgen/validate';

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

interface Schema {
  description?: string;
  properties?: Record<string, Schema>;
  $defs?: Record<string, Schema>;
  allOf?: Schema[];
}

const compactionSpec: SpecDocument = {
  paths: {
    '/v2/catalog/gpus': {
      get: {
        operationId: 'listGpuTypes',
        summary: 'List GPU types',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            schema: { type: 'integer' },
            description:
              'Page size.\n\nResponses carry `pagination.nextCursor`.',
          },
        ],
      },
    },
    '/v2/pods': {
      post: {
        operationId: 'createPod',
        summary: 'Create a pod',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreatePodRequest' },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      BaseContainerConfig: {
        type: 'object',
        description: 'Composition base. Compose ContainerConfig instead.',
        properties: {
          image: { type: 'string', description: 'Container image.' },
        },
      },
      Mounts: {
        type: 'object',
        description:
          'Storage mounts attached to a pod.\n\nPATCH semantics:\n- Omitting `mounts` leaves it unchanged.\n- Clearing is rejected with 400.',
      },
      CreatePodRequest: {
        allOf: [
          { $ref: '#/components/schemas/BaseContainerConfig' },
          {
            type: 'object',
            properties: {
              gpuId: {
                type: 'string',
                description:
                  'GPU **type** id — the `id` field of `GET /v2/catalog/gpus`.\n\nRejected with 400 if unknown (unknown ID → 404). Responses echo it back verbatim. Omit to accept any GPU. ' +
                  'Trailing detail '.repeat(20).trim() +
                  '.',
              },
              note: {
                type: 'string',
                description: 'Long'.repeat(80) + '. Short.',
              },
              mounts: { $ref: '#/components/schemas/Mounts' },
            },
          },
        ],
      },
    },
  },
};

function body(tool: { inputSchema: Record<string, unknown> }): Schema {
  return tool.inputSchema as Schema;
}

test('argument descriptions keep leading sentences and constraints, name tools instead of REST paths, drop output prose and status codes', () => {
  const [create, list] = generateTools(compactionSpec);
  const request = body(create).$defs!.CreatePodRequest.allOf![1].properties!;
  assert.equal(
    request.gpuId.description,
    'GPU type id — the `id` field of `list-gpu-types`. Rejected if unknown (unknown ID). Omit to accept any GPU.'
  );
  // A first sentence past the cap survives whole; nothing is cut mid-sentence.
  assert.equal(request.note.description, 'Long'.repeat(80) + '.');
  assert.equal(
    body(create).$defs!.Mounts.description,
    'Storage mounts attached to a pod. PATCH semantics: Omitting `mounts` leaves it unchanged. Clearing is rejected.'
  );
  assert.equal(
    (body(list).properties as Record<string, Schema>).limit.description,
    'Page size.'
  );
});

test('a definition reached only through allOf loses its composition note but keeps its field descriptions', () => {
  const [create] = generateTools(compactionSpec);
  const base = body(create).$defs!.BaseContainerConfig;
  assert.equal(base.description, undefined);
  assert.equal(base.properties!.image.description, 'Container image.');
  assert.equal(
    body(create).$defs!.Mounts.description?.startsWith('Storage mounts'),
    true,
    'a definition a property points at keeps its description'
  );
});

test('property description overrides replace the spec text by address and reject stale addresses', () => {
  const [create, list] = generateTools(compactionSpec, {
    propertyDescriptions: {
      'CreatePodRequest.gpuId': 'Catalog GPU type id.',
      'CreatePodRequest.mounts': 'Pod storage; see Mounts.',
      Mounts: 'One persistent or one network mount.',
      'listGpuTypes.limit': 'Page size, default 1000.',
    },
  });
  const request = body(create).$defs!.CreatePodRequest.allOf![1].properties!;
  assert.equal(request.gpuId.description, 'Catalog GPU type id.');
  assert.equal(request.mounts.description, 'Pod storage; see Mounts.');
  assert.equal(
    body(create).$defs!.Mounts.description,
    'One persistent or one network mount.'
  );
  assert.equal(
    (body(list).properties as Record<string, Schema>).limit.description,
    'Page size, default 1000.'
  );
  assert.throws(
    () =>
      generateTools(compactionSpec, {
        propertyDescriptions: { 'CreatePodRequest.nope': 'x', Gone: 'y' },
      }),
    /Property description overrides missing from spec: CreatePodRequest\.nope, Gone/
  );
});

test('a description override on a composed schema lands once, not on each member', () => {
  const spec: SpecDocument = {
    ...bodySpec({ $ref: '#/components/schemas/Mounts' }),
    components: {
      schemas: {
        BaseMounts: {
          type: 'object',
          properties: {
            size: { $ref: '#/components/schemas/Size' },
            pair: { $ref: '#/components/schemas/Pair' },
          },
        },
        Mounts: {
          allOf: [
            { $ref: '#/components/schemas/BaseMounts' },
            { type: 'object', properties: { global: { type: 'array' } } },
          ],
        },
        Size: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        Pair: {
          type: 'array',
          prefixItems: [{ type: 'string' }, { type: 'integer' }],
        },
      },
    },
  };
  const overrides = {
    Mounts: 'One persistent or one network mount.',
    Size: 'GB.',
    Pair: 'Name and count.',
  };
  const [tool] = generateTools(spec, { propertyDescriptions: overrides });
  const defs = body(tool).$defs!;
  for (const [name, members] of [
    ['Mounts', 'allOf'],
    ['Size', 'anyOf'],
    ['Pair', 'prefixItems'],
  ] as const) {
    const schema = defs[name] as Record<string, unknown>;
    assert.equal(schema.description, overrides[name]);
    for (const member of schema[members] as Schema[])
      assert.equal(member.description, undefined, `${name}.${members}`);
  }
});

test('schemaOnDemand flags the listed operations and rejects stale ids', () => {
  const spec = bodySpec({ type: 'object' });
  assert.equal(
    generateTools(spec, { schemaOnDemand: ['createExample'] })[0]
      .schemaOnDemand,
    true
  );
  assert.equal(generateTools(spec)[0].schemaOnDemand, undefined);
  assert.throws(
    () => generateTools(spec, { schemaOnDemand: ['oldCreateName'] }),
    /schemaOnDemand operations missing from spec: oldCreateName/
  );
});

test('a conditional beside unevaluatedProperties moves into allOf and keeps its meaning', () => {
  const conditional = {
    if: { required: ['kind'], properties: { kind: { const: 'a' } } },
    then: { required: ['a'], properties: { a: { type: 'string' } } },
    else: { required: ['b'], properties: { b: { type: 'integer' } } },
  };
  const [tool] = generateTools(
    bodySpec({
      type: 'object',
      properties: { kind: { enum: ['a', 'b'] }, a: {}, b: {} },
      unevaluatedProperties: false,
      ...conditional,
    })
  );
  const body = (
    tool.inputSchema.properties as Record<string, Record<string, unknown>>
  ).body;
  for (const key of ['if', 'then', 'else'])
    assert.equal(key in body, false, `${key} must leave the closed schema`);
  // No allOf before, so the conditional is its only member.
  assert.deepEqual(body.allOf, [conditional]);
  assert.equal(body.unevaluatedProperties, false);

  const violations = (value: unknown) =>
    schemaViolations(tool.inputSchema, { body: value }).length;
  assert.equal(violations({ kind: 'a', a: 'x' }), 0, 'then branch accepts');
  // The else branch is the one Ajv mishandled before the rewrite.
  assert.equal(violations({ kind: 'b', b: 1 }), 0, 'else branch accepts');
  assert.notEqual(violations({ kind: 'a' }), 0, 'then still requires a');
  assert.notEqual(violations({ kind: 'b' }), 0, 'else still requires b');
  assert.notEqual(violations({ kind: 'b', b: 1, z: 1 }), 0, 'still closed');
});

test('a conditional without unevaluatedProperties is left in place', () => {
  const schema = {
    type: 'object',
    if: { required: ['kind'] },
    then: { required: ['a'] },
  };
  const [tool] = generateTools(bodySpec(schema));
  assert.deepEqual(
    (tool.inputSchema.properties as Record<string, unknown>).body,
    schema
  );
});
