import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer } from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';
import { createGraphqlClient } from '#src/specgen/clients/graphql';
import { HttpError } from '#src/specgen/clients/http-error';

// Runpod's GraphQL API reports resolver failures with HTTP 200 and an errors
// array, e.g. an unauthenticated `pod` query answers
// {"errors":[{"message":"Unauthorized","extensions":{"code":"UNAUTHORIZED"}}],"data":{"pod":null}}
// with status 200. A tool failure must not carry that 200 forward.
function graphqlReply(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected HttpError, got ${error}`);
    return error.status;
  }
  assert.fail('expected the request to fail');
}

test('GraphQL errors on an HTTP 200 map to a failure status from their code', async () => {
  const cases: Array<[string | undefined, number]> = [
    ['UNAUTHENTICATED', 401],
    ['UNAUTHORIZED', 403],
    ['FORBIDDEN', 403],
    ['RUNPOD', 400],
    ['BAD_USER_INPUT', 400],
    ['INTERNAL_SERVER_ERROR', 502],
    [undefined, 502],
  ];
  for (const [code, expected] of cases) {
    const client = createGraphqlClient({
      apiKey: 'fake',
      publicUrl: 'https://example.invalid/graphql',
      authedUrl: 'https://example.invalid/graphql',
      fetchImpl: graphqlReply({
        errors: [
          { message: 'nope', ...(code ? { extensions: { code } } : {}) },
        ],
        data: { saveEndpoint: null },
      }),
    });
    assert.equal(
      await statusOf(client.authed('mutation { x }')),
      expected,
      String(code)
    );
  }
});

test('a 200 with no data, or a non-array errors field, is still an HttpError', async () => {
  for (const body of [{ data: null }, { errors: 'internal failure' }]) {
    const client = createGraphqlClient({
      publicUrl: 'https://example.invalid/graphql',
      fetchImpl: graphqlReply(body),
    });
    assert.equal(
      await statusOf(client.public('query { x }')),
      502,
      JSON.stringify(body)
    );
  }
});

test('a GraphQL error on a curated tool reaches the agent with a recovery hint', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = graphqlReply({
    errors: [
      {
        message: 'Something went wrong',
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      },
    ],
    data: null,
  });
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'fake', sdkRetry: false }),
    'test'
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({
      name: 'list-hub-repos',
      arguments: {},
    });
    assert.equal(result.isError, true);
    const payload = JSON.parse(
      (result.content as Array<{ text: string }>)[0].text
    );
    assert.match(payload.error, /Something went wrong/);
    assert.ok(payload.hint, 'expected a recovery hint on the failed call');
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = original;
  }
});

test('a RUNPOD input error reaches the agent as a 400 with a fix-the-input hint', async () => {
  const original = globalThis.fetch;
  // Live saveEndpoint answer for gpuIds "NOT_A_GPU", trimmed.
  globalThis.fetch = graphqlReply({
    errors: [
      {
        message: 'Invalid GPU Pool ID: "NOT_A_GPU".',
        path: ['saveEndpoint'],
        extensions: { code: 'RUNPOD' },
      },
    ],
    data: null,
  });
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'fake', sdkRetry: false }),
    'test'
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({
      name: 'list-hub-repos',
      arguments: {},
    });
    assert.equal(result.isError, true);
    const payload = JSON.parse(
      (result.content as Array<{ text: string }>)[0].text
    );
    // The shape hint is served only for a 400 or 422.
    assert.match(payload.hint, /Input shape mismatch/);
    assert.doesNotMatch(payload.hint, /Upstream Runpod error/);
  } finally {
    await client.close();
    await server.close();
    globalThis.fetch = original;
  }
});
