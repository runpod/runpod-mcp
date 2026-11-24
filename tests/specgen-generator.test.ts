import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generateRowSchemas,
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

// A list operation as the spec writes one: rows in one array, the API's own
// limit and cursor, and the API's page-size default in the description.
function listSpec(
  rows: Record<string, unknown>,
  limitMaximum = 1000
): SpecDocument {
  return {
    paths: {
      '/v2/things': {
        get: {
          operationId: 'listThings',
          summary: 'List things',
          description:
            'Returns things, newest first, cursor-paginated; an omitted `limit` defaults to 1000. Follow `pagination.nextCursor` until `hasNextPage` is false.',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', maximum: limitMaximum },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: rows },
                },
              },
            },
          },
        },
      },
    },
  } as SpecDocument;
}

test('a list operation is paged through the shared list contract', () => {
  const [tool] = generateTools(
    listSpec({
      things: { type: 'array', items: { type: 'object' } },
      pagination: { type: 'object' },
    }),
    {}
  );
  assert.deepEqual(tool.list, {
    rows: 'things',
    paged: 'api',
    rowSchema: { type: 'object', open: true },
  });
  const properties = tool.inputSchema.properties as Record<
    string,
    Record<string, unknown>
  >;
  assert.equal(properties.jmespath.type, 'string');
  assert.equal(properties.limit.maximum, 100);
  assert.equal(properties.limit.default, 20);
  assert.equal(properties.cursor.type, 'string');
  assert.equal(
    tool.description,
    'List things. Returns things, newest first, cursor-paginated.'
  );
});

// The jmespath field check (src/specgen/list-query.ts) reads this shape:
// refs resolved, allOf/anyOf/oneOf merged, null dropped from types, integer
// as number, enums kept, free-form maps open.
test("a list carries its rows' fields for the jmespath check", () => {
  const spec = listSpec({
    things: { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
    pagination: { type: 'object' },
  });
  spec.components = {
    schemas: {
      Thing: {
        allOf: [
          { type: 'object', properties: { id: { type: 'string' } } },
          {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ON', 'OFF', null] },
              size: { type: ['integer', 'null'] },
              env: { type: 'object', additionalProperties: { type: 'string' } },
              gpu: {
                anyOf: [
                  { type: 'object', properties: { id: { type: 'string' } } },
                  {
                    type: 'object',
                    properties: { count: { type: 'integer' } },
                  },
                ],
              },
              tags: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { key: { type: 'string' } },
                },
              },
            },
          },
        ],
      },
    },
  };
  const [tool] = generateTools(spec, {});
  assert.deepEqual(tool.list?.rowSchema, {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['ON', 'OFF'] },
      size: { type: 'number' },
      env: { type: 'object', open: true },
      gpu: {
        type: 'object',
        properties: { id: { type: 'string' }, count: { type: 'number' } },
      },
      tags: {
        type: 'array',
        items: { type: 'object', properties: { key: { type: 'string' } } },
      },
    },
  });
});

// A discriminated oneOf (the spec's endpoint scaling) keeps every variant's
// enum values, and a field the variants type differently goes unchecked:
// a value one variant allows must never be refused. allOf is the opposite
// of oneOf/anyOf: its parts all hold at once, so a type-only part and an
// enum-only part combine into one type-and-enum constraint, not drop to
// just the type.
test("a list merges its rows' variants without losing a value", () => {
  const spec = listSpec({
    things: { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
    pagination: { type: 'object' },
  });
  spec.components = {
    schemas: {
      Thing: {
        type: 'object',
        properties: {
          scaling: {
            oneOf: [
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['QUEUE_DELAY'] },
                  queueDelay: { type: 'integer' },
                },
              },
              {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['REQUEST_COUNT'] },
                  requestCount: { type: 'integer' },
                },
              },
            ],
          },
          value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
          kind: { allOf: [{ type: 'string' }, { enum: ['a', 'b'] }] },
        },
      },
    },
  };
  const [tool] = generateTools(spec, {});
  assert.deepEqual(tool.list?.rowSchema.properties, {
    scaling: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['QUEUE_DELAY', 'REQUEST_COUNT'] },
        queueDelay: { type: 'number' },
        requestCount: { type: 'number' },
      },
    },
    value: {},
    kind: { type: 'string', enum: ['a', 'b'] },
  });
});

// A variant with no type, enum or properties of its own documents no
// constraint at all ("any other shape, not yet documented"): the field
// becomes fully open, not narrowed to what the other variants happen to
// type, since a value the undocumented variant allows must never be refused.
test('an undocumented union member leaves the field open, not narrowed to the typed member', () => {
  const spec = listSpec({
    things: { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
    pagination: { type: 'object' },
  });
  spec.components = {
    schemas: {
      Thing: {
        type: 'object',
        properties: {
          scaling: {
            oneOf: [
              {
                type: 'object',
                properties: { type: { type: 'string', enum: ['QUEUE_DELAY'] } },
              },
              { description: 'Any other shape, not yet documented.' },
            ],
          },
        },
      },
    },
  };
  const [tool] = generateTools(spec, {});
  assert.deepEqual(tool.list?.rowSchema.properties, { scaling: {} });
});

// The standard "nullable ref" union (anyOf: [$ref, {type: 'null'}], as the
// spec writes every nullable object field) is not an undocumented variant:
// it carries no shape of its own on purpose, and must not make the merge
// drop the ref's real shape down to {} as if it were a catch-all member.
test("a nullable ref ({type: 'null'}) keeps the ref's shape, not {}", () => {
  const spec = listSpec({
    things: { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
    pagination: { type: 'object' },
  });
  spec.components = {
    schemas: {
      Thing: {
        type: 'object',
        properties: {
          proxy: {
            anyOf: [
              { $ref: '#/components/schemas/Endpoint' },
              { type: 'null' },
            ],
          },
        },
      },
      Endpoint: {
        type: 'object',
        properties: { host: { type: 'string' } },
      },
    },
  };
  const [tool] = generateTools(spec, {});
  assert.deepEqual(tool.list?.rowSchema.properties, {
    proxy: { type: 'object', properties: { host: { type: 'string' } } },
  });
});

// A $ref cycle (a buggy or malformed upstream spec, not something this
// server controls) must not hang generation: resolveRef's hop cap bounds it.
test('a circular $ref stops row-schema generation instead of hanging', () => {
  const spec = listSpec({
    things: { type: 'array', items: { $ref: '#/components/schemas/A' } },
    pagination: { type: 'object' },
  });
  spec.components = {
    schemas: {
      A: { $ref: '#/components/schemas/B' },
      B: { $ref: '#/components/schemas/A' },
    },
  };
  const [tool] = generateTools(spec, {});
  assert.deepEqual(tool.list?.rowSchema, {});
});

test("a list's row schema takes items, open maps and types from merged parts", () => {
  const spec = listSpec({
    things: { type: 'array', items: { $ref: '#/components/schemas/Thing' } },
    pagination: { type: 'object' },
  });
  spec.components = {
    schemas: {
      Thing: {
        allOf: [
          // A part with fields and no type of its own.
          { properties: { id: { type: 'string' } } },
          {
            type: 'object',
            properties: {
              labels: {
                allOf: [
                  { type: 'array' },
                  { items: { type: 'string', enum: ['a'] } },
                ],
              },
              meta: {
                allOf: [
                  { type: 'object' },
                  { additionalProperties: { type: 'string' } },
                ],
              },
              mixed: {
                type: 'object',
                properties: { known: { type: 'string' } },
                additionalProperties: true,
              },
              // Fields from one part, any key from another; no type anywhere.
              split: {
                allOf: [
                  { properties: { a: { type: 'string' } } },
                  { additionalProperties: true },
                ],
              },
              untyped: { properties: { b: { type: 'number' } } },
            },
          },
        ],
      },
    },
  };
  const [tool] = generateTools(spec, {});
  assert.deepEqual(tool.list?.rowSchema, {
    type: 'object',
    properties: {
      id: { type: 'string' },
      labels: { type: 'array', items: { type: 'string', enum: ['a'] } },
      meta: { type: 'object', open: true },
      mixed: {
        type: 'object',
        properties: { known: { type: 'string' } },
        open: true,
      },
      split: {
        type: 'object',
        properties: { a: { type: 'string' } },
        open: true,
      },
      untyped: { type: 'object', properties: { b: { type: 'number' } } },
    },
  });
  assert.throws(
    () => generateRowSchemas(spec, { listRowSchemas: { 'list-x': 'Missing' } }),
    /list-x names a missing schema Missing/
  );
});

test('a list operation the generator cannot page fails generation', () => {
  assert.throws(
    () => generateTools(listSpec({ pagination: { type: 'object' } }), {}),
    /listThings needs exactly one array of rows .* found 0/
  );
  assert.throws(
    () =>
      generateTools(
        listSpec({
          things: { type: 'array' },
          others: { type: 'array' },
        }),
        {}
      ),
    /found 2/
  );
  assert.throws(
    () => generateTools(listSpec({ things: { type: 'array' } }, 50), {}),
    /caps limit at 50, below the shared maximum 100/
  );
  assert.throws(
    () => generateTools(listSpec({ things: { type: 'array' } }), {}),
    /takes a cursor but returns no pagination block/
  );
});

test('a list can set its own default page size in the generator config', () => {
  const spec = listSpec({
    things: { type: 'array', items: { type: 'object' } },
    pagination: { type: 'object' },
  });
  const [tool] = generateTools(spec, {
    listDefaultLimits: { listThings: 100 },
  });
  assert.equal(tool.list?.defaultLimit, 100);
  const limit = (
    tool.inputSchema.properties as Record<string, Record<string, unknown>>
  ).limit;
  assert.equal(limit.default, 100);
  assert.match(String(limit.description), /default 100/);
  assert.throws(
    () => generateTools(spec, { listDefaultLimits: { listThings: 0 } }),
    /must be 1-100, got 0/
  );
  assert.throws(
    () => generateTools(spec, { listDefaultLimits: { createThing: 50 } }),
    /not generated lists: createThing/
  );
});
