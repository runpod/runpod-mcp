// ALP P0 gates: config-gated registration, honest response contracts,
// scrub-on-write, identity keying, and the fail-soft posture.
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSpecgenServer, curatedTools } from '../src/specgen/server.js';
import { createToolContext } from '../src/specgen/context.js';
import { generatedTools } from '../src/specgen/generated/tools.gen.js';
import { createAlpTools } from '../src/specgen/tools/alp.js';
import { handleAlpSubmit, isSinkUrl } from '../src/alp/ingest.js';
import {
  clampLimit,
  handleAlpJournalRead,
  journalSinkUrl,
} from '../src/alp/read.js';
import { journalReadUrl } from '../src/specgen/tools/alp.js';
import { scrub, SCRUBBED_FIELDS, scrubSubmission } from '../src/alp/scrub.js';
import { ALP_SEVERITIES } from '../src/alp/ingest.js';

const ALP_WRITE_NAMES = ['report_feedback', 'save_to_journal', 'ask_question'];
const ALP_NAMES = [...ALP_WRITE_NAMES, 'read_journal'];

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

test('configured means present: the four ALP tools appear, with honest wording', async () => {
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
  assert.match(journal.description ?? '', /read_journal returns these entries/);
  const read = tools.find((t) => t.name === 'read_journal')!;
  assert.match(read.description ?? '', /cannot read any other account/);
  assert.deepEqual(Object.keys(read.inputSchema.properties ?? {}), ['limit']);
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
    env: {
      ALP_SINK_URL: 'https://sink-test-1.convex.site/alp/submit',
      ALP_SINK_SECRET: 's3cret',
    },
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

// A 200 without the sink's own { ok, id } body must NOT be reported as
// recorded: "recorded" should mean a row exists, not that some host answered.
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
    env: {
      ALP_SINK_URL: 'https://sink-test-1.convex.site/alp/submit',
      ALP_SINK_SECRET: 's3cret',
    },
  });
  assert.equal(written.statusCode, 200);
  const body = JSON.parse(written.body!);
  assert.equal(body.recorded, false);
  assert.match(body.note, /did not confirm/);
  assert.match(body.note, /Do not retry/);
});

// A sink URL that is not shaped like the sink is a config error, not a write.
test('a sink URL that is not the sink is refused before any request', async () => {
  let called = false;
  const { req, res, written } = fakeReqRes(
    { authorization: 'Bearer rpa_live' },
    { route: 'feedback', content: 'nowhere to go' }
  );
  await handleAlpSubmit(req, res, {
    verify: async () => ({ status: 'valid', accountId: 'user_42' }),
    sinkFetch: (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
    env: {
      ALP_SINK_URL: 'https://example.com/alp/submit',
      ALP_SINK_SECRET: 's3cret',
    },
  });
  assert.equal(JSON.parse(written.body!).recorded, false);
  assert.match(JSON.parse(written.body!).note, /misconfigured/);
  assert.equal(called, false, 'no request should leave for a bad sink URL');
});

test('isSinkUrl accepts only a Convex ingest action', () => {
  assert.ok(isSinkUrl('https://cautious-mallard-692.convex.site/alp/submit'));
  assert.ok(!isSinkUrl('http://a.convex.site/alp/submit'), 'http');
  assert.ok(!isSinkUrl('https://a.convex.site/'), 'wrong path');
  assert.ok(!isSinkUrl('https://a.convex.cloud/alp/submit'), 'wrong host');
  assert.ok(!isSinkUrl('https://evil.test/alp/submit'), 'wrong host');
  assert.ok(!isSinkUrl('not a url'), 'unparseable');
});

test('scrub catches the obvious credential shapes', () => {
  const { text, redactions } = scrub(
    'key rpa_abcdefghijklmnop1234, header Bearer eyJx.aaaa.bbbb, aws AKIAABCDEFGHIJKLMNOP'
  );
  assert.ok(!text.includes('rpa_abcdefghijklmnop1234'));
  assert.ok(!text.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(redactions >= 2, `expected >=2 redactions, got ${redactions}`);
});

test('scrub redacts config values in JSON, shell and YAML while preserving useful context', () => {
  for (const input of [
    '{"env":{"DATABASE_PASSWORD":"fake password with spaces","PORT":"8080"}}',
    'AWS_SECRET_ACCESS_KEY=fake-secret\nPORT=8080',
    "databasePassword: 'fake password with spaces'\nPORT: 8080",
    '{"clientSecret":"fake\\\"quoted-password","PORT":8080}',
  ]) {
    const result = scrub(input);
    assert.ok(!result.text.includes('fake'), result.text);
    assert.match(result.text, /8080/);
    assert.equal(result.redactions, 1);
    assert.deepEqual(scrub(result.text), { text: result.text, redactions: 0 });
  }
});

test('ingest scrubs config and metadata before the storage boundary', async () => {
  let row: Record<string, unknown> = {};
  const { req, res, written } = fakeReqRes(
    { authorization: 'Bearer fake' },
    {
      route: 'feedback',
      content: '{"env":{"DATABASE_PASSWORD":"fake-db-password"}}',
      intention: 'API_TOKEN=fake-token',
      modelType: 'rpa_abcdefghijklmnop1234',
      harness: 'password=fake-password',
    }
  );
  await handleAlpSubmit(req, res, {
    verify: async () => ({ status: 'valid', accountId: 'account' }),
    env: {
      ALP_SINK_URL: 'https://test.convex.site/alp/submit',
      ALP_SINK_SECRET: 'fake',
    },
    sinkFetch: (async (_u: RequestInfo | URL, init?: RequestInit) => {
      row = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, id: 'row' }));
    }) as typeof fetch,
  });
  assert.equal(JSON.parse(written.body!).recorded, true);
  assert.ok(!JSON.stringify(row).includes('fake-'));
  assert.ok(!JSON.stringify(row).includes('rpa_abcdefghijklmnop1234'));
  assert.equal(row.redactions, 4);
  // The sink repeats the same pass before insertion; no double counting.
  const { scrubSubmission } = await import('../src/alp/scrub.js');
  const input = {
    content: 'DATABASE_PASSWORD=fake-secret',
    redactions: 0,
    scrubVersion: 1,
  };
  const stored = scrubSubmission(input);
  assert.ok(!stored.content.includes('fake-secret'));
  assert.deepEqual(scrubSubmission(stored), stored);
});

// Pass ORDER is the security property here, so it gets its own test.
// Several anchored patterns recognize a credential by the token in front of
// it: `bearer` matches `Bearer <opaque>`, never the opaque part alone. The
// assignment pass stops an unquoted value at the first space, so when it ran
// first it rewrote `Authorization: Bearer <opaque>` to
// `Authorization: [redacted:config] <opaque>` — consuming the word "Bearer",
// destroying the anchor, and leaving the credential in plaintext. It read as
// a redaction while being a leak, which is the only reason it survived
// review: every other value in the fixtures was independently matched by a
// pattern (jwt, rpa_, sk_), so nothing noticed.
test('an unquoted Bearer credential is redacted, anchor and all', () => {
  const opaque = 'abcdefghijklmnopqrstuvwxyz123456';
  for (const input of [
    `Authorization: Bearer ${opaque}`,
    `cookie: Bearer ${opaque}`,
    `authorization = "Bearer ${opaque}"`,
    `{"authorization": "Bearer ${opaque}"}`,
  ]) {
    const { text, redactions } = scrub(input);
    assert.ok(!text.includes(opaque), `leaked the credential: ${text}`);
    assert.match(text, /\[redacted:bearer\]/, `lost the anchor: ${text}`);
    assert.equal(redactions, 1, `double-counted: ${text}`);
    // Re-scrubbing at the sink must not change it or inflate the count.
    const again = scrub(text);
    assert.equal(again.text, text);
    assert.equal(again.redactions, 0);
  }
});

// Sensitive key names are matched by segment, not substring. Over-redaction
// has a real cost here: the corpus exists to be read.
test('config redaction keys match by segment, not substring', () => {
  for (const benign of [
    'tokenizer: llama-3',
    'model: gpt-4o',
    'const timeout = 5000;',
    'the ratio is 3:1 at 10:30',
  ]) {
    assert.equal(scrub(benign).redactions, 0, `false positive: ${benign}`);
    assert.equal(scrub(benign).text, benign);
  }
  // camelCase has no separator to split on, so the segment split has to
  // break on case boundaries too — otherwise `clientSecret` reads as one
  // opaque word and sails through.
  for (const secret of [
    'access_token: xyzsecretvalue',
    'apikey=abcdefgvalue',
    'apiKey=abcdefgvalue',
    'DB_PASSWORD=letmein',
    'export ALP_SINK_SECRET=s3cr3tvalue',
    "databasePassword: 'fake password with spaces'",
    '{"clientSecret":"fakevalue"}',
  ]) {
    const { text, redactions } = scrub(secret);
    assert.ok(redactions > 0, `missed a secret: ${secret}`);
    assert.match(text, /\[redacted:config\]/);
  }
});

// Stage B. Header values are DEFINED by containing spaces and semicolons
// (`Basic <cred>`, `a=1; b=2`), which is exactly what the token-level
// assignment matcher cannot hold whole — it redacted the word "Basic" and
// left the credential, and took only the first cookie of three. Found by
// review after the Bearer fix: that fix closed one instance of this class.
test('sensitive header values are redacted whole, not tokenized', () => {
  const cred = 'QWxhZGRpbjpvcGVuIHNlc2FtZQ==';
  for (const input of [
    `Authorization: Basic ${cred}`,
    `Proxy-Authorization: Basic ${cred}`,
    `Authorization: Token ${cred}`,
    `  authorization:   Basic ${cred}  `,
    'cookie: session=abc123secretvalue; csrf=def456othervalue; theme=dark',
    'Set-Cookie: sid=abc123secretvalue; Path=/; HttpOnly',
  ]) {
    const { text, redactions } = scrub(input);
    assert.ok(!text.includes(cred), `leaked credential: ${text}`);
    assert.ok(!/abc123|def456/.test(text), `leaked cookie: ${text}`);
    assert.match(text, /\[redacted:(header|bearer)\]/);
    assert.equal(redactions, 1, `should be one whole-value redaction: ${text}`);
    const again = scrub(text);
    assert.equal(again.text, text);
    assert.equal(again.redactions, 0);
  }
  // Inline, mid-sentence, several on one line — the shape real pastes take.
  // The first version anchored ^…$ and missed all of these live.
  const inline = scrub(
    `got 401 with Authorization: Basic ${cred} | cookie: session=abc123secretvalue; csrf=def456othervalue; theme=dark | then SERVICE_API_KEY=fake-opaque-credential and tokenizer: llama-3`
  );
  assert.ok(!inline.text.includes(cred), `inline Basic leaked: ${inline.text}`);
  assert.ok(
    !/abc123|def456|fake-opaque/.test(inline.text),
    `inline leaked: ${inline.text}`
  );
  assert.match(
    inline.text,
    /Authorization: \[redacted:header\] \| cookie: \[redacted:header\]/
  );
  assert.match(inline.text, /tokenizer: llama-3$/);
  assert.equal(inline.redactions, 3);
  // A Bearer value is already taken by stage A; stage B must not double-count.
  const bearer = scrub(
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'
  );
  assert.equal(bearer.text, 'Authorization: [redacted:bearer]');
  assert.equal(bearer.redactions, 1);
});

// Stage C. `key` qualifies by the segment right before it, anywhere in the
// name. The previous check anchored `^api_key$` on the joined segments, so
// any service prefix defeated it and SERVICE_API_KEY passed through intact.
test('qualified key names are sensitive with any prefix, plain key is not', () => {
  for (const input of [
    'SERVICE_API_KEY=fake-opaque-credential',
    'STRIPE_API_KEY=fake-opaque-credential',
    'MY_ACCESS_KEY=fake-opaque-credential',
    'aws.secretKey = fake-opaque-credential',
    'apikey=fake-opaque-credential',
    'clientKey: fake-opaque-credential',
  ]) {
    const { text, redactions } = scrub(input);
    assert.ok(!text.includes('fake-opaque-credential'), `missed: ${input}`);
    assert.equal(redactions, 1);
  }
  for (const benign of [
    'primary_key: id',
    'cache_key = users',
    'key: value',
    'keyboard: qwerty',
  ]) {
    assert.equal(scrub(benign).text, benign, `false positive: ${benign}`);
  }
});

test('ingest only stores and logs recognized transport values', async () => {
  const originalLog = console.log;
  const canary = 'rpa_FAKECANARY1234567890';
  try {
    for (const transport of [
      'http',
      'stdio',
      canary,
      { secret: canary },
      undefined,
    ]) {
      const logs: unknown[][] = [];
      let stored: Record<string, unknown> = {};
      console.log = (...args: unknown[]) => {
        logs.push(args);
      };
      const { req, res, written } = fakeReqRes(
        { authorization: 'Bearer fake' },
        {
          route: 'feedback',
          content: 'normal feedback',
          transport,
        }
      );
      await handleAlpSubmit(req, res, {
        verify: async () => ({ status: 'valid', accountId: 'account' }),
        env: {
          ALP_SINK_URL: 'https://test.convex.site/alp/submit',
          ALP_SINK_SECRET: 'fake',
        },
        sinkFetch: (async (_u, init) => {
          stored = JSON.parse(String(init?.body));
          return new Response('{"ok":true,"id":"row"}');
        }) as typeof fetch,
      });
      assert.equal(JSON.parse(written.body!).recorded, true);
      const expected =
        transport === 'http' || transport === 'stdio' ? transport : undefined;
      assert.equal(stored.transport, expected);
      assert.equal(logs.length, 1);
      assert.equal(JSON.parse(String(logs[0][1])).transport, expected);
      assert.ok(!JSON.stringify(logs).includes(canary));
      assert.ok(!JSON.stringify(stored).includes(canary));
    }
  } finally {
    console.log = originalLog;
  }
});

// The scrub list is hand-maintained, and a submission field missing from it is
// stored verbatim — the exact failure that leaks a pasted credential. Nothing
// in the type system connects the two, so read the shape from source and
// require every field to be covered. Adding a field to AlpSubmitBody without
// adding it to SCRUBBED_FIELDS fails here instead of in the table.
test('every agent-writable submission field is scrubbed', () => {
  const src = readFileSync(
    new URL('../src/alp/ingest.ts', import.meta.url),
    'utf8'
  );
  const block = /export interface AlpSubmitBody \{([\s\S]*?)\n\}/.exec(src);
  assert.ok(
    block,
    'AlpSubmitBody not found — update this test with the rename'
  );
  const fields = [...block[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(fields.length > 5, `parsed too few fields: ${fields.join(',')}`);
  // `route` is set by which tool was called, never agent prose, and is
  // validated against ALP_ROUTES before it is stored.
  for (const field of fields.filter((f) => f !== 'route')) {
    assert.ok(
      (SCRUBBED_FIELDS as readonly string[]).includes(field),
      `AlpSubmitBody.${field} is not in SCRUBBED_FIELDS — it would be stored unscrubbed`
    );
  }
});

// Every assert.ok in this file carries a message on purpose. Without one, a
// failing assert.ok makes Node re-read and parse the source file to print the
// offending expression, and under the tsx loader that took tens of seconds to
// never — the file looked hung six tests earlier because the reporter had
// only flushed that far. Verified 2026-09-09 by bisecting a forced failure.
test('the new triage fields are scrubbed, not just carried', () => {
  const row = scrubSubmission({
    content: 'ok',
    workaround: 'retried with Authorization: Bearer sk-live-abcdefghijklmnop',
    trigger: 'when x-api-key: abcdefghijklmnopqrst is set',
    tool: 'create-pod',
    severity: 'blocked',
    redactions: 0,
    scrubVersion: 0,
  });
  assert.ok(
    !row.workaround?.includes('sk-live-abcdefghijklmnop'),
    'workaround was stored unscrubbed'
  );
  assert.ok(
    !row.trigger?.includes('abcdefghijklmnopqrst'),
    'trigger was stored unscrubbed'
  );
  assert.equal(row.tool, 'create-pod');
  assert.equal(row.severity, 'blocked');
  assert.ok(row.redactions >= 2, `expected redactions, got ${row.redactions}`);
});

// severity only earns its place if it stays sortable, so an off-enum value is
// dropped rather than stored as prose.
test('ingest keeps severity on the enum and drops anything else', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const sinkFetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, id: 'row_1' }), {
      status: 200,
    });
  }) as typeof fetch;
  for (const severity of [...ALP_SEVERITIES, 'critical', 'P0', 42]) {
    const { req, res } = fakeReqRes(
      { authorization: 'Bearer rpa_live' },
      { route: 'feedback', content: 'c', severity, tool: 'create-pod' }
    );
    await handleAlpSubmit(req, res, {
      verify: async () => ({ status: 'valid', accountId: 'user_42' }),
      sinkFetch,
      env: {
        ALP_SINK_URL: 'https://sink-test-1.convex.site/alp/submit',
        ALP_SINK_SECRET: 's3cret',
      },
    });
  }
  assert.deepEqual(
    seen.map((r) => r.severity),
    ['blocked', 'degraded', 'cosmetic', undefined, undefined, undefined]
  );
  // the free-text neighbour rides along untouched on the dropped-severity row
  assert.equal(seen[3].tool, 'create-pod');
});

// 150 of one afternoon's production rows were `ask_question` with content
// "placeholder", from one Claude Agent SDK app that forces a tool call every
// turn. The agents said so in their own intentions ("a pro forma call to
// comply with the tool-usage guidance"). A write-only tool that never errors is
// the cheapest way to satisfy a forced call, so the text has to say, where the
// agent reads it, that calling nothing is the correct move.
test('ALP text forbids pro forma and placeholder calls', async () => {
  const { SERVER_INSTRUCTIONS, createSpecgenServer: _ } = await import(
    '../src/specgen/server.js'
  );
  void _;
  const client = await connect({
    alp: { ingestUrl: 'https://ingest.invalid/x', transport: 'http' },
  });
  const instructions = client.getInstructions() ?? '';
  assert.match(
    instructions,
    /never call one to satisfy a requirement to use a tool/
  );
  assert.match(instructions, /If you have nothing to report, call nothing/);
  // Contribution is voluntary and never touches sensitive work: the briefing
  // must say both, and say what submissions are stored for.
  assert.match(instructions, /CONTRIBUTING BACK IS OPTIONAL/);
  assert.match(instructions, /DO NOT USE THEM when the work is sensitive/);
  assert.match(instructions, /stored for review to improve agent workflows/);
  assert.match(
    instructions,
    /describe the Runpod behavior, not the user's project/
  );
  assert.doesNotMatch(
    SERVER_INSTRUCTIONS,
    /call nothing/,
    'the rule lives in the ALP block, not the base briefing'
  );
  const { tools } = await client.listTools();
  for (const name of ['ask_question', 'report_feedback']) {
    const t = tools.find((x) => x.name === name)!;
    assert.match(
      t.description ?? '',
      /never call this to satisfy a requirement to use a tool/,
      name
    );
    assert.match(t.description ?? '', /placeholder/, name);
  }
  await client.close();
});

// modelType was filled on 1% of Claude Code rows and 53% of Cursor rows — the
// harness that names the model in its prompt is the one that fills it. The
// old wording ("if you know it") read as permission to skip. Ask for a best
// guess explicitly; keep it optional so call-through does not move.
test('modelType asks for a best guess and stays optional', async () => {
  const client = await connect({
    alp: { ingestUrl: 'https://ingest.invalid/x', transport: 'http' },
  });
  const { tools } = await client.listTools();
  for (const name of ALP_WRITE_NAMES) {
    const schema = tools.find((t) => t.name === name)!.inputSchema as {
      properties: Record<string, { description?: string }>;
      required?: string[];
    };
    assert.match(schema.properties.modelType.description ?? '', /best/i, name);
    assert.match(
      schema.properties.modelType.description ?? '',
      /probably/,
      name
    );
    assert.doesNotMatch(
      schema.properties.modelType.description ?? '',
      /if you know it/,
      name
    );
    assert.deepEqual(
      schema.required,
      ['content'],
      `${name} must keep content the only required arg`
    );
  }
  await client.close();
});

// ---- journal read-back ----

const VALID_VERIFY = async () => ({
  status: 'valid' as const,
  accountId: 'acct_me',
});
const READ_ENV = {
  ALP_SINK_URL: 'https://sink.convex.site/alp/submit',
  ALP_SINK_SECRET: 'shh',
};

test('journal read 401s without a bearer token and never touches the sink', async () => {
  let sinkCalls = 0;
  const { req, res, written } = fakeReqRes({}, { limit: 5 });
  await handleAlpJournalRead(req, res, {
    env: READ_ENV,
    sinkFetch: (async () => {
      sinkCalls++;
      return new Response('{}');
    }) as typeof fetch,
  });
  assert.equal(written.statusCode, 401);
  assert.equal(sinkCalls, 0, 'no sink call without a credential');
});

test('journal read scopes to the TOKEN identity; an identity in the body is ignored', async () => {
  const sent: unknown[] = [];
  const { req, res, written } = fakeReqRes(
    { authorization: 'Bearer rpa_x' },
    { identity: 'acct_someone_else', limit: 3 }
  );
  await handleAlpJournalRead(req, res, {
    env: READ_ENV,
    verify: VALID_VERIFY,
    sinkFetch: (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          ok: true,
          entries: [{ content: 'x', receivedAt: 't' }],
        })
      );
    }) as typeof fetch,
  });
  assert.equal(written.statusCode, 200);
  assert.deepEqual(sent, [
    {
      url: 'https://sink.convex.site/alp/journal',
      body: { identity: 'acct_me', limit: 3 },
    },
  ]);
  const body = JSON.parse(written.body!);
  assert.equal(body.available, true);
  assert.equal(body.entries.length, 1);
});

test('journal read fails closed: sink down, wrong shape, or unresolved identity yield zero entries', async () => {
  const cases: Array<[string, Parameters<typeof handleAlpJournalRead>[2]]> = [
    [
      'sink 500',
      {
        env: READ_ENV,
        verify: VALID_VERIFY,
        sinkFetch: (async () =>
          new Response('x', { status: 500 })) as typeof fetch,
      },
    ],
    [
      'sink unrecognized',
      {
        env: READ_ENV,
        verify: VALID_VERIFY,
        sinkFetch: (async () => new Response('{"ok":true}')) as typeof fetch,
      },
    ],
    [
      'sink unreachable',
      {
        env: READ_ENV,
        verify: VALID_VERIFY,
        sinkFetch: (async () => {
          throw new Error('ECONNREFUSED');
        }) as typeof fetch,
      },
    ],
    [
      'identity unknown',
      {
        env: READ_ENV,
        verify: async () => ({ status: 'unknown' as const }),
        sinkFetch: (async () => {
          throw new Error('must not be called');
        }) as typeof fetch,
      },
    ],
    [
      'no sink configured',
      {
        env: {},
        verify: VALID_VERIFY,
        sinkFetch: (async () => {
          throw new Error('must not be called');
        }) as typeof fetch,
      },
    ],
  ];
  for (const [label, opts] of cases) {
    const { req, res, written } = fakeReqRes(
      { authorization: 'Bearer rpa_x' },
      {}
    );
    await handleAlpJournalRead(req, res, opts);
    assert.equal(written.statusCode, 200, `${label}: calm 200`);
    const body = JSON.parse(written.body!);
    assert.equal(body.available, false, `${label}: available=false`);
    assert.deepEqual(body.entries, [], `${label}: no entries`);
    assert.match(body.note, /Do not retry/, `${label}: no-retry note`);
  }
});

test('journal read rejects an invalid key with 401', async () => {
  const { req, res, written } = fakeReqRes(
    { authorization: 'Bearer rpa_dead' },
    {}
  );
  await handleAlpJournalRead(req, res, {
    env: READ_ENV,
    verify: async () => ({ status: 'invalid' as const }),
  });
  assert.equal(written.statusCode, 401);
});

test('journal limit clamps to [1, 50] and defaults on garbage', () => {
  assert.equal(clampLimit(undefined), 20);
  assert.equal(clampLimit('abc'), 20);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-4), 1);
  assert.equal(clampLimit(7.9), 7);
  assert.equal(clampLimit(999), 50);
  assert.equal(clampLimit('12'), 12);
});

test('journal sink URL is derived from the submit URL, never configured separately', () => {
  assert.equal(
    journalSinkUrl('https://sink.convex.site/alp/submit'),
    'https://sink.convex.site/alp/journal'
  );
  assert.equal(journalSinkUrl('https://evil.example/alp/submit'), null);
  assert.equal(journalSinkUrl('not a url'), null);
  assert.equal(
    journalReadUrl('https://mcp.getrunpod.io/api/alp/submit'),
    'https://mcp.getrunpod.io/api/alp/journal'
  );
});

test('read_journal tool fails soft when the read endpoint is unreachable', async () => {
  const client = await connect({
    alp: { ingestUrl: 'http://127.0.0.1:9/api/alp/submit', transport: 'stdio' },
  });
  const result = await client.callTool({
    name: 'read_journal',
    arguments: { limit: 5 },
  });
  assert.equal(result.isError ?? false, false, 'read_journal never errors');
  const text = (result.content as Array<{ text: string }>)[0].text;
  const payload = JSON.parse(text);
  assert.equal(payload.available, false);
  assert.deepEqual(payload.entries, []);
  assert.match(payload.note, /Do not retry/);
  await client.close();
});
