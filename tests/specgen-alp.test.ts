// ALP P0 gates: config-gated registration, honest response contracts,
// scrub-on-write, identity keying, and the fail-soft posture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer, curatedTools } from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';
import { generatedTools } from '../src/specgen/generated/tools.gen.js';
import { createAlpTools } from '../src/specgen/tools/alp.js';
import { handleAlpSubmit } from '../src/alp/ingest.js';
import { scrub } from '../src/alp/scrub.js';

const ALP_NAMES = ['report_feedback', 'save_to_journal', 'ask_question'];

async function connect(opts?: Parameters<typeof createSpecgenServer>[2]) {
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test',
    opts
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

test('disabled means absent: no ALP config, no ALP tools in tools/list', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.equal(tools.length, generatedTools.length + curatedTools.length);
  for (const name of ALP_NAMES) {
    assert.ok(!tools.some((t) => t.name === name), `${name} must be absent`);
  }
  await client.close();
});

test('configured means present: the three write tools appear, with honest wording', async () => {
  const client = await connect({
    alp: { ingestUrl: 'http://127.0.0.1:9/api/alp/submit', transport: 'stdio' },
  });
  const { tools } = await client.listTools();
  assert.equal(
    tools.length,
    generatedTools.length + curatedTools.length + ALP_NAMES.length
  );
  const ask = tools.find((t) => t.name === 'ask_question')!;
  assert.match(ask.description ?? '', /NO ANSWER WILL COME BACK/);
  const journal = tools.find((t) => t.name === 'save_to_journal')!;
  assert.match(journal.description ?? '', /cannot be read back yet/i);
  await client.close();
});

test('ask_question response repeats the no-answer contract even on failure', async () => {
  // Unreachable ingest (port 9): the tool must fail soft — a successful,
  // non-error result that says the entry was not recorded and not to retry.
  const client = await connect({
    alp: { ingestUrl: 'http://127.0.0.1:9/api/alp/submit', transport: 'stdio' },
  });
  const res = (await client.callTool({
    name: 'ask_question',
    arguments: { content: 'how do I frobnicate?' },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.ok(!res.isError, 'ALP failures must not be tool errors');
  const body = JSON.parse(res.content[0].text) as {
    recorded: boolean;
    note: string;
  };
  assert.equal(body.recorded, false);
  assert.match(body.note, /Do not retry/);
  await client.close();
});

test('the submitted body carries the args and attribution, never more', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ recorded: true }), { status: 200 });
  }) as typeof fetch;
  try {
    const [tool] = createAlpTools({
      ingestUrl: 'https://sink.test/api/alp/submit',
      transport: 'http',
      harness: 'claude-code',
      harnessSource: 'user_agent',
    });
    const ctx = createToolContext({ apiKey: 'rpa_test' });
    const result = await tool.handler(ctx, {
      content: 'create-pod 400s on X',
      intention: 'deploying a pod',
    });
    assert.equal((result.payload as { recorded: boolean }).recorded, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]).sort(), [
    'content',
    'harness',
    'harnessSource',
    'intention',
    'route',
    'transport',
  ]);
  assert.equal(seen[0].route, 'feedback');
});

// ---- ingest endpoint ----

function fakeReqRes(headers: Record<string, string>, body?: unknown) {
  const written: { statusCode?: number; body?: string } = {};
  const req = { headers, body } as never;
  const res = {
    writeHead(code: number) {
      written.statusCode = code;
      return this;
    },
    end(payload?: string) {
      written.body = payload;
    },
  } as never;
  return { req, res, written };
}

test('ingest 401s without a bearer token', async () => {
  const { req, res, written } = fakeReqRes({});
  await handleAlpSubmit(req, res, { env: {} });
  assert.equal(written.statusCode, 401);
});

test('ingest keys the row on the resolved account id and forwards the secret', async () => {
  const forwarded: Array<{
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const { req, res, written } = fakeReqRes(
    { authorization: 'Bearer rpa_live' },
    {
      route: 'journal',
      content: 'lesson: rpa_SECRETKEY1234567890 was pasted here',
    }
  );
  await handleAlpSubmit(req, res, {
    verify: async () => ({ status: 'valid', accountId: 'user_42' }),
    sinkFetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      forwarded.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true, id: 'row_1' }), {
        status: 200,
      });
    }) as typeof fetch,
    env: { ALP_SINK_URL: 'https://sink.test', ALP_SINK_SECRET: 's3cret' },
  });
  assert.equal(written.statusCode, 200);
  assert.equal(JSON.parse(written.body!).recorded, true);
  assert.equal(forwarded.length, 1);
  const { headers, body } = forwarded[0];
  assert.equal(headers['X-ALP-Secret'], 's3cret');
  assert.equal(body.identity, 'user_42');
  // Scrub-on-write: the pasted key never reaches the sink.
  assert.ok(!String(body.content).includes('rpa_SECRETKEY1234567890'));
  assert.match(String(body.content), /\[redacted:runpod_key\]/);
  assert.equal(body.redactions, 1);
});

test('ingest is honest when no sink is configured', async () => {
  const { req, res, written } = fakeReqRes(
    { authorization: 'Bearer rpa_live' },
    { route: 'question', content: 'anyone home?' }
  );
  await handleAlpSubmit(req, res, {
    verify: async () => ({ status: 'valid', accountId: 'user_42' }),
    env: {},
  });
  assert.equal(written.statusCode, 200);
  const body = JSON.parse(written.body!);
  assert.equal(body.recorded, false);
  assert.match(body.note, /Do not retry/);
});

// Regression: a wrong ALP_SINK_URL answering 200 without the sink's own
// { ok, id } body must NOT be reported as recorded. Observed live on the
// preview deployment (2026-09-03): three acked submissions, zero stored rows.
test('a 200 from the wrong host is not a stored write', async () => {
  const { req, res, written } = fakeReqRes(
    { authorization: 'Bearer rpa_live' },
    { route: 'feedback', content: 'went to the void' }
  );
  await handleAlpSubmit(req, res, {
    verify: async () => ({ status: 'valid', accountId: 'user_42' }),
    // A static page: 200, but nothing resembling the sink's contract.
    sinkFetch: (async () =>
      new Response('<html>hello</html>', { status: 200 })) as typeof fetch,
    env: { ALP_SINK_URL: 'https://wrong.test', ALP_SINK_SECRET: 's3cret' },
  });
  assert.equal(written.statusCode, 200);
  const body = JSON.parse(written.body!);
  assert.equal(body.recorded, false);
  assert.match(body.note, /did not confirm/);
  assert.match(body.note, /Do not retry/);
});

test('scrub catches the obvious credential shapes', () => {
  const { text, redactions } = scrub(
    'key rpa_abcdefghijklmnop1234, header Bearer eyJx.aaaa.bbbb, aws AKIAABCDEFGHIJKLMNOP'
  );
  assert.ok(!text.includes('rpa_abcdefghijklmnop1234'));
  assert.ok(!text.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(redactions >= 2, `expected >=2 redactions, got ${redactions}`);
});
