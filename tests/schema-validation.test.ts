// Full-schema argument validation (src/specgen/validate.ts): what it reports,
// what it treats as an omission, and how each MCP_SCHEMA_VALIDATION mode
// changes a call's outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer } from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { argsAsSent, omittedEmptyQueryArg } from '#src/specgen/dispatch';
import { schemaValidationMode, schemaViolations } from '#src/specgen/validate';

function generated(name: string) {
  const tool = generatedTools.find((t) => t.name === name);
  assert.ok(tool, name);
  return tool;
}

function check(name: string, args: Record<string, unknown>) {
  const tool = generated(name);
  return schemaViolations(tool.inputSchema, args, omittedEmptyQueryArg(tool));
}

// What server.ts validates: the arguments as dispatch will send them.
function checkSent(name: string, args: Record<string, unknown>) {
  const tool = generated(name);
  const sent = argsAsSent(tool, args);
  assert.ok(sent, 'body should parse');
  return schemaViolations(tool.inputSchema, sent, omittedEmptyQueryArg(tool));
}

test('mode defaults to shadow and accepts only off and enforce otherwise', () => {
  assert.equal(schemaValidationMode(''), 'shadow');
  assert.equal(schemaValidationMode('bogus'), 'shadow');
  assert.equal(schemaValidationMode(' Enforce '), 'enforce');
  assert.equal(schemaValidationMode('off'), 'off');
});

test('a nested enum failure names the path and the allowed values', () => {
  const [violation, ...rest] = check('pod-action', {
    id: 'p',
    body: { action: 'halt' },
  });
  assert.equal(rest.length, 0);
  assert.equal(violation.path, 'body.action');
  assert.equal(violation.keyword, 'enum');
  assert.deepEqual(violation.allowed, [
    'start',
    'stop',
    'restart',
    'terminate',
  ]);
});

test('a nested unknown key is reported at its own path', () => {
  const violations = check('pod-action', {
    id: 'p',
    body: { action: 'stop', force: true },
  });
  assert.deepEqual(
    violations.map((v) => [v.path, v.keyword]),
    [['body.force', 'additionalProperties']]
  );
});

test('a range failure on a top-level argument is reported', () => {
  const violations = check('list-pods', { limit: 5000 });
  assert.deepEqual(
    violations.map((v) => [v.path, v.keyword]),
    [['limit', 'maximum']]
  );
});

test('a conditional requirement reports the missing field, not the if wrapper', () => {
  // The v1 spelling `imageName` is the mistake the stale-schema hint was
  // written for; the full schema names the field the API actually wants.
  const violations = check('create-pod', {
    body: { name: 'x', imageName: 'runpod/base' },
  });
  assert.ok(violations.every((v) => v.keyword !== 'if'));
  assert.ok(
    violations.some((v) => v.path === 'body.image' && v.keyword === 'required'),
    JSON.stringify(violations)
  );
});

test('a valid create-pod body passes', () => {
  assert.deepEqual(
    check('create-pod', {
      body: {
        name: 'x',
        image: 'runpod/base',
        gpu: { id: 'NVIDIA GeForce RTX 4090', count: 1 },
      },
    }),
    []
  );
});

test('null optionals are omissions at any depth; a null required is missing', () => {
  // Strict-schema clients send every property, nulling the ones they skip.
  assert.deepEqual(check('list-pods', { cursor: null, limit: null }), []);
  assert.deepEqual(
    check('create-pod', {
      body: { name: 'x', image: 'runpod/base', templateId: null },
    }),
    []
  );
  const violations = check('pod-action', { id: 'p', body: { action: null } });
  assert.deepEqual(
    violations.map((v) => [v.path, v.keyword]),
    [['body.action', 'required']]
  );
});

test('an empty optional query parameter is not reported', () => {
  // dispatch drops it before the request; reporting it would be a false alarm.
  assert.deepEqual(check('list-pods', { cursor: '' }), []);
});

test('a null array item is a value, not an omission', () => {
  const schema = {
    type: 'object',
    properties: { tags: { type: 'array', items: { type: 'string' } } },
  };
  const violations = schemaViolations(schema, { tags: ['a', null] });
  assert.deepEqual(
    violations.map((v) => [v.path, v.keyword]),
    [['tags.1', 'type']]
  );
});

test('a body sent as a JSON string is checked as the object dispatch sends', () => {
  assert.deepEqual(
    checkSent('exec-pod', {
      id: 'p',
      body: JSON.stringify({ command: ['ls'] }),
    }),
    []
  );
  assert.deepEqual(
    checkSent('exec-pod', { id: 'p', body: { command: ['ls'] } }),
    []
  );
});

test('number strings in the body are checked after dispatch converts them', () => {
  assert.deepEqual(
    checkSent('exec-pod', {
      id: 'p',
      body: { command: ['ls'], timeoutSeconds: '5' },
    }),
    []
  );
  assert.deepEqual(
    checkSent('exec-pod', {
      id: 'p',
      body: JSON.stringify({ command: ['ls'], timeoutSeconds: '5' }),
    }),
    []
  );
  assert.deepEqual(
    checkSent('update-pod', { id: 'p', body: { disk: '20' } }),
    []
  );
});

test('a real error inside a stringified body is still reported', () => {
  const violations = checkSent('exec-pod', {
    id: 'p',
    body: JSON.stringify({ timeoutSeconds: 5 }),
  });
  assert.deepEqual(
    violations.map((v) => [v.path, v.keyword]),
    [['body.command', 'required']]
  );
});

test('a body string that is not valid JSON is left to dispatch', () => {
  assert.equal(argsAsSent(generated('exec-pod'), { id: 'p', body: '{' }), null);
});

async function callPodAction(
  mode: string | undefined,
  action: string,
  apiKey: string | undefined = 'fake'
) {
  return callTool(mode, 'pod-action', { id: 'p', body: { action } }, apiKey);
}

async function callTool(
  mode: string | undefined,
  name: string,
  args: Record<string, unknown>,
  apiKey: string | undefined = 'fake'
) {
  const savedMode = process.env.MCP_SCHEMA_VALIDATION;
  const savedKey = process.env.RUNPOD_API_KEY;
  if (mode === undefined) delete process.env.MCP_SCHEMA_VALIDATION;
  else process.env.MCP_SCHEMA_VALIDATION = mode;
  delete process.env.RUNPOD_API_KEY;
  const original = globalThis.fetch;
  const originalError = console.error;
  const logs: string[] = [];
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ id: 'p', desiredStatus: 'EXITED' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  console.error = (...parts: unknown[]) => {
    logs.push(parts.map(String).join(' '));
  };
  const server = createSpecgenServer(
    createToolContext({ apiKey, sdkRetry: false }),
    'test'
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({ name, arguments: args });
    return {
      requests,
      logs: logs.filter((line) => line.startsWith('schema_violation')),
      isError: result.isError,
      payload: JSON.parse((result.content as Array<{ text: string }>)[0].text),
    };
  } finally {
    globalThis.fetch = original;
    console.error = originalError;
    if (savedMode === undefined) delete process.env.MCP_SCHEMA_VALIDATION;
    else process.env.MCP_SCHEMA_VALIDATION = savedMode;
    if (savedKey !== undefined) process.env.RUNPOD_API_KEY = savedKey;
    await client.close();
    await server.close();
  }
}

test('shadow mode (the default) logs a violation and still sends the call', async () => {
  const { requests, logs } = await callPodAction(undefined, 'halt');
  assert.equal(requests, 1);
  assert.equal(logs.length, 1);
  const entry = JSON.parse(logs[0].slice('schema_violation '.length));
  assert.equal(entry.tool, 'pod-action');
  assert.equal(entry.mode, 'shadow');
  assert.deepEqual(entry.violations, [
    { keyword: 'enum', schemaPath: '#/$defs/PodAction/enum' },
  ]);
  // The log records schema locations only, never argument values.
  assert.ok(!logs[0].includes('halt'));
});

test('enforce mode rejects before any request, with field-level errors', async () => {
  const { requests, logs, isError, payload } = await callPodAction(
    'enforce',
    'halt'
  );
  assert.equal(requests, 0);
  assert.equal(logs.length, 1);
  assert.equal(isError, true);
  assert.equal(payload.code, 'invalid_arguments');
  assert.deepEqual(payload.fields, [
    {
      path: 'body.action',
      problem: 'must be equal to one of the allowed values',
      allowed: ['start', 'stop', 'restart', 'terminate'],
    },
  ]);
  // pod-action lists its full schema, so no describe-tool pointer is added.
  assert.doesNotMatch(payload.hint, /describe-tool/);
});

test('enforce mode reports a shape error even without an API key', async () => {
  // Before this, the missing key's 401 hid the shape problem.
  const { payload } = await callPodAction('enforce', 'halt', undefined);
  assert.equal(payload.code, 'invalid_arguments');
});

test('enforce mode lets a valid call through', async () => {
  const { requests, logs, isError } = await callPodAction('enforce', 'stop');
  assert.equal(requests, 1);
  assert.equal(logs.length, 0);
  assert.notEqual(isError, true);
});

test('off mode neither logs nor blocks', async () => {
  const { requests, logs } = await callPodAction('off', 'halt');
  assert.equal(requests, 1);
  assert.equal(logs.length, 0);
});

test('enforce mode sends a stringified body with number strings', async () => {
  const { requests, logs, isError } = await callTool('enforce', 'exec-pod', {
    id: 'p',
    body: JSON.stringify({ command: ['ls'], timeoutSeconds: '5' }),
  });
  assert.equal(requests, 1);
  assert.equal(logs.length, 0);
  assert.notEqual(isError, true);
});

test('a body string that is not valid JSON gets the dispatch error, not a violation', async () => {
  const { requests, logs, payload } = await callTool('enforce', 'exec-pod', {
    id: 'p',
    body: '{',
  });
  assert.equal(requests, 0);
  assert.equal(logs.length, 0);
  assert.match(payload.error, /not valid JSON/);
});
