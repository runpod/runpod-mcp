import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callShape,
  listTool,
  listedAnnotations,
  DESCRIBE_TOOL_NAME,
} from '#src/specgen/on-demand';
import { similarNames } from '#src/specgen/tools/describe';

const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const full = {
  type: 'object',
  properties: {
    podId: {
      type: 'string',
      description: 'Pod id. Find it with list-pods.',
      examples: ['abc'],
    },
    mode: {
      type: 'string',
      enum: ['fast', 'slow'],
      description: 'Speed, e.g. fast for small jobs. Defaults to slow.',
    },
    body: { $ref: '#/$defs/Body' },
    tags: {
      type: 'array',
      items: { $ref: '#/$defs/Tag' },
      description: 'Labels.',
    },
    either: { anyOf: [{ $ref: '#/$defs/Body' }, { $ref: '#/$defs/Tag' }] },
    mixed: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/Tag' }] },
  },
  required: ['podId', 'body'],
  $defs: {
    Body: {
      type: 'object',
      description: 'The request. Every field is optional.',
      properties: { name: { type: 'string' } },
    },
    Tag: { type: 'object', properties: { key: { type: 'string' } } },
  },
};

test('callShape keeps the top-level arguments and collapses everything beneath them', () => {
  assert.deepEqual(callShape(full), {
    type: 'object',
    properties: {
      podId: { type: 'string', description: 'Pod id.' },
      mode: {
        type: 'string',
        enum: ['fast', 'slow'],
        description: 'Speed, e.g. fast for small jobs.',
      },
      body: { type: 'object', description: 'The request.' },
      tags: {
        type: 'array',
        items: { type: 'object' },
        description: 'Labels.',
      },
      either: { type: 'object' },
      mixed: {},
    },
    required: ['podId', 'body'],
  });
});

test('listTool passes ordinary tools through and shortens flagged ones with a pointer', () => {
  const tool = {
    name: 'x',
    title: 'X',
    description: 'Does x.',
    inputSchema: full,
    annotations,
  };
  const served = {
    ...tool,
    annotations: { title: 'X', ...listedAnnotations(annotations) },
  };
  assert.deepEqual(listTool(tool), served);
  const listed = listTool({ ...tool, schemaOnDemand: true });
  assert.ok(listed.description.startsWith('Does x. '));
  assert.match(listed.description, new RegExp(DESCRIBE_TOOL_NAME));
  assert.deepEqual(listed.inputSchema, callShape(full));
  assert.deepEqual(listed.annotations, served.annotations);
  assert.equal(listed.title, 'X');
  assert.equal('schemaOnDemand' in listed, false);
});

test('listedAnnotations leaves out idempotentHint only when false', () => {
  assert.deepEqual(listedAnnotations(annotations), {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(
    listedAnnotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
    {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
  );
});

test('similarNames offers the tools sharing a word with a guessed name', () => {
  const names = [
    'get-pod',
    'list-pods',
    'pod-action',
    'create-endpoint',
    'list-endpoints',
  ];
  assert.deepEqual(similarNames('start-pod', names), [
    'get-pod',
    'list-pods',
    'pod-action',
  ]);
  assert.deepEqual(similarNames('endpoints', names), [
    'create-endpoint',
    'list-endpoints',
  ]);
  assert.deepEqual(similarNames('nonsense', names), []);
});
