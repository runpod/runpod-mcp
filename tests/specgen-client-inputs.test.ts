import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunpodClient } from '@runpod/typescript-api-sdk';
import { dispatchGeneratedTool } from '#src/specgen/dispatch';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { createRuntimeClient } from '#src/specgen/clients/runtime';
import { HttpError } from '#src/specgen/clients/http-error';

test('a null required path argument fails before any REST request', async () => {
  let requests = 0;
  const sdk = createRunpodClient({
    apiKey: 'test',
    fetch: async () => {
      requests++;
      return new Response('{}');
    },
  });
  const tool = generatedTools.find((tool) => tool.name === 'get-pod')!;
  const result = await dispatchGeneratedTool(sdk, tool, { id: null });
  assert.equal(result.status, 400);
  assert.match(JSON.stringify(result.payload), /Missing required argument: id/);
  assert.equal(requests, 0);
});

test('runtime client rejects endpoint path injection before sending a key', async () => {
  let requests = 0;
  const runtime = createRuntimeClient({
    apiKey: 'test',
    fetchImpl: async () => {
      requests++;
      return new Response('{}');
    },
  });
  for (const id of [
    'abc/../x',
    '..',
    '%2e%2e',
    'abc?other=x',
    'abc#x',
    'abc\\x',
    ' abc',
    '',
  ]) {
    await assert.rejects(
      runtime(id, '/health'),
      (error) => error instanceof HttpError && error.status === 400
    );
  }
  assert.equal(requests, 0);
  await runtime('endpoint_123-ab', '/health');
  assert.equal(requests, 1);
});

test('a Markdown success body is returned as text, not parsed as JSON', async () => {
  const readme = '# PyTorch 2.8\n\nRun `python app.py`.';
  const sdk = createRunpodClient({
    apiKey: 'test',
    fetch: async () =>
      new Response(readme, {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      }),
  });
  for (const name of [
    'get-template-readme',
    'get-public-template-readme',
    'get-catalog-repo-readme',
  ]) {
    const tool = generatedTools.find((tool) => tool.name === name)!;
    assert.equal(tool.textResponse, true);
    const result = await dispatchGeneratedTool(sdk, tool, { id: 'tpl_abc' });
    assert.equal(result.ok, true);
    assert.equal(result.payload, readme);
  }
});

test('only non-JSON success bodies are flagged as text', () => {
  const flagged = generatedTools
    .filter((tool) => tool.textResponse)
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(flagged, [
    'get-catalog-repo-readme',
    'get-public-template-readme',
    'get-template-readme',
  ]);
});
