// OpenAI's plugin portal fetches this token to verify the MCP server's domain
// before it connects and scans the tools.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import handler, { OPENAI_APPS_CHALLENGE_TOKEN } from '../api/index.js';

test('serves the OpenAI apps challenge token as plain text', async () => {
  const headers: Record<string, string> = {};
  let status: number | undefined;
  let body: unknown;
  const req = {
    method: 'GET',
    url: '/.well-known/openai-apps-challenge',
    headers: { host: 'mcp.test' },
    on() {},
  } as unknown as Parameters<typeof handler>[0];
  const res = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      status = code;
      return this;
    },
    send(payload: unknown) {
      body = payload;
      return this;
    },
  } as unknown as Parameters<typeof handler>[1];

  await handler(req, res);
  assert.equal(status, 200);
  assert.equal(body, OPENAI_APPS_CHALLENGE_TOKEN);
  assert.match(headers['content-type'], /^text\/plain/);
});
