// Every request-body example in the vendored spec is a call the API documents
// as valid, so MCP_SCHEMA_VALIDATION=enforce must accept it. This is the gate
// that caught enforce rejecting every QUEUE create-endpoint (an Ajv quirk with
// `if`/`then` beside `unevaluatedProperties`; see specgen/generator/tools.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { schemaViolations } from '#src/specgen/validate';

interface Example {
  operationId: string;
  name: string;
  value: unknown;
}

function requestBodyExamples(): Example[] {
  const spec = parse(
    readFileSync('packages/typescript-api-sdk/spec/openapi.yaml', 'utf8')
  );
  const examples: Example[] = [];
  for (const item of Object.values(spec.paths) as Record<string, unknown>[]) {
    for (const op of Object.values(item)) {
      if (!op || typeof op !== 'object' || !('operationId' in op)) continue;
      const { operationId, requestBody } = op as {
        operationId: string;
        requestBody?: { content?: Record<string, Record<string, unknown>> };
      };
      const media = requestBody?.content?.['application/json'];
      if (!media) continue;
      if ('example' in media)
        examples.push({ operationId, name: 'example', value: media.example });
      for (const [name, entry] of Object.entries(
        (media.examples ?? {}) as Record<string, { value?: unknown }>
      ))
        examples.push({ operationId, name, value: entry.value });
    }
  }
  return examples;
}

function argsFor(operationId: string, body: unknown) {
  const tool = generatedTools.find((t) => t.operationId === operationId);
  if (!tool) return undefined;
  const args: Record<string, unknown> = { body };
  for (const param of tool.params)
    if (param.location === 'path') args[param.name] = 'example-id';
  return { tool, args };
}

const examples = requestBodyExamples();

test('the spec carries request-body examples to check', () => {
  // A broken loader would make the next test vacuously pass.
  assert.ok(examples.length >= 30, `only ${examples.length} examples found`);
  assert.ok(examples.some((e) => e.operationId === 'createEndpoint'));
});

test('every spec request-body example passes full-schema validation', () => {
  const failures: string[] = [];
  for (const example of examples) {
    const call = argsFor(example.operationId, example.value);
    if (!call) continue; // operation excluded from the tool surface
    const violations = schemaViolations(call.tool.inputSchema, call.args);
    if (violations.length)
      failures.push(
        `${call.tool.name} [${example.name}]: ${JSON.stringify(violations)}`
      );
  }
  assert.deepEqual(failures, []);
});

test('create-endpoint still enforces its conditional and closed body', () => {
  const tool = generatedTools.find((t) => t.name === 'create-endpoint')!;
  const queue = {
    name: 'n',
    image: 'i',
    type: 'QUEUE',
    scaling: { type: 'QUEUE_DELAY', queueDelay: 4 },
  };
  const loadBalancer = {
    ...queue,
    type: 'LOAD_BALANCER',
    scaling: { type: 'REQUEST_COUNT', requestCount: 4 },
  };
  assert.deepEqual(schemaViolations(tool.inputSchema, { body: queue }), []);
  assert.deepEqual(
    schemaViolations(tool.inputSchema, { body: loadBalancer }),
    []
  );
  assert.notDeepEqual(
    schemaViolations(tool.inputSchema, {
      body: { ...loadBalancer, scaling: queue.scaling },
    }),
    [],
    'LOAD_BALANCER must require REQUEST_COUNT scaling'
  );
  assert.notDeepEqual(
    schemaViolations(tool.inputSchema, { body: { ...queue, bogus: 1 } }),
    [],
    'an unknown body field must still be rejected'
  );
});
