// The jmespath argument of list tools (src/specgen/list-query.ts and the scan
// in src/specgen/pagination.ts), rule by rule. The core rule: walking a
// filtered list page by page returns exactly what the expression gives on
// the whole list, in order, each row once, however the API pages it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { search } from 'jmespath';
import { createRunpodClient } from '@runpod/typescript-api-sdk';
import { dispatchGeneratedTool } from '#src/specgen/dispatch';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { curatedTools } from '#src/specgen/server';
import { redactSecretEnv } from '#src/specgen/redact';
import { serializeResult } from '#src/specgen/serialize';
import { createDescribeTool } from '#src/specgen/tools/describe';
import {
  directoryIncludes,
  directoryOmittedInputs,
} from '#src/specgen/profile';
import {
  compileListQuery,
  JMESPATH_MAX_LENGTH,
  type RowSchema,
} from '#src/specgen/list-query';
import {
  MAX_LIST_LIMIT,
  MAX_SCAN_PAGES,
  PAGE_BUDGET_BYTES,
  queryInMemory,
  type Pagination,
} from '#src/specgen/pagination';

type Row = Record<string, unknown>;
type Page = { pods: Row[]; pagination: Pagination };
type Result = { ok: boolean; status: number; payload: unknown };

const listPods = generatedTools.find((tool) => tool.name === 'list-pods')!;
const STATUSES = ['RUNNING', 'EXITED', 'STARTING'];

// Pod rows as the v2 API sends them, with a secret in env.
const pod = (i: number, extra: Row = {}): Row => ({
  id: `p${i}`,
  name: `pod-${i % 7 === 0 ? 'gpu' : 'cpu'}-${i}`,
  status: STATUSES[i % 3],
  cost: i % 5 === 0 ? null : (i % 13) / 10,
  createdAt: `2026-${String((i % 12) + 1).padStart(2, '0')}-01T00:00:00Z`,
  env: { API_KEY: `secret-${i}`, MODE: i % 2 ? 'a' : 'b' },
  ...(i % 4 === 0 ? {} : { gpu: { id: i % 2 ? 'A40' : 'H100', count: i % 4 } }),
  tags: i % 6 === 0 ? [{ key: 'team', value: 'ml' }] : [],
  ...extra,
});
const pods = (count: number, extra?: (i: number) => Row) =>
  Array.from({ length: count }, (_, i) => pod(i, extra?.(i)));

// A paged API like Runpod's (as in specgen-lists.test.ts): a key cursor that
// names the last row returned; an unknown cursor or a limit over 100 is a 400.
function pagedApi(
  all: Row[],
  calls: URL[],
  key = 'pods',
  // Answers instead of a page: an API error, or a broken pagination block.
  answer?: (call: number, url: URL) => Response | undefined
) {
  return createRunpodClient({
    apiKey: 'test',
    // A fake error should reach dispatch at once, not after backoff.
    retry: false,
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push(url);
      const instead = answer?.(calls.length, url);
      if (instead) return instead;
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      const after = url.searchParams.get('cursor');
      const found = after ? all.findIndex((row) => row.id === after) : -1;
      if ((after && found === -1) || limit > MAX_LIST_LIMIT)
        return Response.json({ status: 400 }, { status: 400 });
      const start = found + 1;
      const page = all.slice(start, start + limit);
      const more = start + page.length < all.length;
      return Response.json({
        [key]: page,
        pagination: {
          hasNextPage: more,
          nextCursor: more ? page[page.length - 1].id : null,
        },
      });
    },
  });
}

// Matches resultBytes in pagination.ts: the page budget is measured as the
// server actually sends it (compact by default; see serialize.ts), not as
// pretty-printed JSON — a leftover from before compact JSON landed made
// this measure 30,936 pretty bytes for a page that is really under budget.
const bytes = (value: unknown) =>
  Buffer.byteLength(serializeResult(redactSecretEnv(value)));

// Follows nextCursor to the end, checking every page on the way. Returns the
// rows, the pages, and the API calls each tool call made.
async function walk(all: Row[], args: Row) {
  const calls: URL[] = [];
  const api = pagedApi(all, calls);
  const seen: Row[] = [];
  const pages: Pagination[] = [];
  let cursor: string | undefined;
  for (let call = 0; call < 2000; call++) {
    const before = calls.length;
    const result = (await dispatchGeneratedTool(api, listPods, {
      ...args,
      ...(cursor ? { cursor } : {}),
    })) as Result;
    assert.ok(result.ok, JSON.stringify(result.payload));
    const page = result.payload as Page;
    const made = calls.slice(before);
    assert.ok(made.length <= MAX_SCAN_PAGES, `${made.length} API calls`);
    for (const url of made)
      assert.equal(url.searchParams.get('limit'), `${MAX_LIST_LIMIT}`);
    assert.ok(
      bytes(page) <= PAGE_BUDGET_BYTES || page.pods.length === 1,
      `${bytes(page)} bytes in ${page.pods.length} rows: ${JSON.stringify(args)}`
    );
    assert.equal(page.pagination.returned, page.pods.length);
    // An empty page is normal on a filtered list: no match in the rows read
    // (more may follow), or none in the last rows (the end).
    seen.push(...page.pods);
    pages.push(page.pagination);
    if (!page.pagination.hasNextPage) {
      assert.equal(page.pagination.nextCursor, null);
      return { seen, pages, calls };
    }
    cursor = page.pagination.nextCursor!;
  }
  throw new Error('walk did not end');
}

const oracle = (all: Row[], expression: string) =>
  search(redactSecretEnv(all), expression) as Row[];

const call = async (all: Row[], args: Row) => {
  const calls: URL[] = [];
  const result = (await dispatchGeneratedTool(
    pagedApi(all, calls),
    listPods,
    args
  )) as Result;
  return { result, calls, payload: result.payload as Record<string, unknown> };
};

// ------------------------------------------------------------ checks first

test('a bad expression is a 400 that says how to fix it, before any API call', async () => {
  const cases: [string, RegExp, string?][] = [
    ['[?status==', /Not a valid JMESPath expression/],
    ['x'.repeat(JMESPATH_MAX_LENGTH + 1), /the limit is 500/],
    ["[?desiredStatus=='RUNNING']", /Unknown field 'desiredStatus'/, 'fields'],
    ['[?status == RUNNING]', /Unknown field 'RUNNING'/],
    ["[?status=='RUNING']", /status is never "RUNING"/, 'allowed'],
    ["[?cost > '0.5']", /cost is a number, compared here with the text/],
    ['[?name == `1`]', /name is text, compared here with the number/],
    ['[?gpu.id.x]', /has no fields/],
    ["[?tags[?kee=='team']]", /Unknown field 'kee'/],
    ['[?env.constructor]', /'constructor' is not a field/],
    ['[?__proto__]', /'__proto__' is not a field/],
    ['constructor(@)', /Unknown function constructor/],
    ["[?status=='RUNNING'] | [0]", /A pipe/],
    ['[?status][id, name]', /A list of values/],
    ["[?contains(['RUNNING', 'STARTING'], status)]", /A list of values/],
    [
      "[?tags.key=='team']",
      /'key' is read from a list, where it is always null/,
    ],
    ["[?tags[*].key=='team']", /is a list, compared here with one value/],
    ["[?ports=='8888/http']", /ports is a list, compared here with one value/],
    ['length(@)', /does not return rows/],
    ['[0]', /does not return rows/],
    ['[:5]', /returns single values|does not return rows/],
    ["[?status=='RUNNING'].id", /returns single values/],
    ['max_by(@, &cost)', /does not return rows/],
    ['sort_by([].{c: cost}, &cost)', /Unknown field 'cost'. Fields here: c/],
    ['`1`', /does not return rows/],
    ['sort_by(@, id)', /does not return rows/],
    ['sort_by(@, &id, &name)', /does not return rows/],
    ['reverse(sort_by(@, &id), @)', /does not return rows/],
    ['[].{a: [id, id]}', /A list of values/],
    ['[].{__proto__: id}', /'__proto__' cannot be an output column/],
    ['[].{a: env.constructor}', /'constructor' is not a field/],
    ['[].{a: foo(id)}', /Unknown function foo/],
    ["[?tags[0].kee == 'x']", /Unknown field 'kee'/],
    ['[?max_by(tags, &key).kee]', /Unknown field 'kee'/],
    ['[].{x: pods[0]}', /Unknown field 'pods'/],
    ['1', /Not a valid JMESPath expression/],
    // An indexed path (tags[0].key) has a resolvable schema even without a
    // printable field name; it must be type-checked the same as a plain field.
    ['[?tags[0].key == `1`]', /is text, compared here with the number/],
    // A number or text field compared with true/false, not just the reverse.
    ['[?cost == `true`]', /cost is a number, compared here with true/],
    ['[?id == `true`]', /id is text, compared here with true/],
    // map's array argument is a plain field read on the row, not a per-item
    // one, and must be checked the same as any other field.
    ['[?length(map(&key, tagz)) > `0`]', /Unknown field 'tagz'. Fields here: /],
    // The length cap is on what was actually sent, not on the text with the
    // rows key stripped off: that strip only ever drops "pods" itself, so
    // padding around a redundant leading "pods" must not buy extra room.
    [
      `pods[?id${' '.repeat(JMESPATH_MAX_LENGTH - 5)}]`,
      new RegExp(
        `jmespath is ${JMESPATH_MAX_LENGTH + 4} characters; the limit is ${JMESPATH_MAX_LENGTH}`
      ),
    ],
  ];
  for (const [expression, error, extra] of cases) {
    const { result, calls, payload } = await call(pods(10), {
      jmespath: expression,
    });
    assert.equal(result.status, 400, expression);
    assert.equal(payload.code, 'invalid_jmespath', expression);
    assert.match(String(payload.error), error, expression);
    assert.ok(payload.hint, expression);
    if (extra) assert.ok(extra in payload, `${expression}: ${extra}`);
    assert.equal(calls.length, 0, `${expression} reached the API`);
  }
  const notText = await call(pods(10), { jmespath: 5 });
  assert.equal(notText.payload.code, 'invalid_jmespath');
  assert.equal(notText.calls.length, 0);
});

test('the hints name the working form', async () => {
  const set = await call(pods(5), {
    jmespath: "[?contains(['RUNNING', 'STARTING'], status)]",
  });
  assert.match(
    String(set.payload.hint),
    /status=='RUNNING' \|\| status=='STARTING'/
  );
  const list = await call(pods(5), { jmespath: "[?tags.key=='team']" });
  assert.match(String(list.payload.hint), /\[\?tags\[\?key=='team'\]\]/);
});

// jmespath is patched (patches/jmespath@0.16.0.patch): an ordering
// comparison with null, or between a number and text, is null, as the
// JMESPath spec has it; plain JavaScript counted null as 0.
test('< and > never match a missing value', async () => {
  const all = pods(60);
  const { payload } = await call(all, {
    jmespath: '[?cost < `0.5`].{id: id}',
    limit: 100,
  });
  const expected = all
    .filter((row) => typeof row.cost === 'number' && row.cost < 0.5)
    .map((row) => ({ id: row.id }));
  assert.ok(all.some((row) => row.cost === null));
  assert.deepEqual(payload.pods, expected);
  const below = await call(all, {
    jmespath: '[?cost >= `0`].{id: id}',
    limit: 100,
  });
  assert.equal(
    (below.payload.pods as Row[]).length,
    all.filter((row) => row.cost !== null).length
  );
  const dates = await call(all, {
    jmespath: "[?createdAt >= '2026-06'].{id: id}",
    limit: 100,
  });
  assert.deepEqual(
    dates.payload.pods,
    all
      .filter((row) => String(row.createdAt) >= '2026-06')
      .map((row) => ({ id: row.id }))
  );
});

test('[*] and [] are every row', async () => {
  const all = pods(30);
  for (const jmespath of ['[*]', '[]', 'sort_by([*], &id)']) {
    const { payload } = await call(all, { jmespath, limit: 100 });
    assert.equal((payload.pods as Row[]).length, 30, jmespath);
  }
});

test("columns never make a row larger than the list's own rows", async () => {
  for (const jmespath of [
    '[].{a: @, b: @}',
    "[?status=='RUNNING'].{a: env, b: env, c: env, d: env, e: env, f: env, g: env, h: env}",
    'sort_by([].{a: @, b: @}, &a.id)',
  ]) {
    const { payload } = await call(pods(20), { jmespath, limit: 100 });
    assert.equal(payload.code, 'invalid_jmespath', jmespath);
    assert.match(
      String(payload.error),
      /larger than the rows of the list/,
      jmespath
    );
  }
});

// These all drop most of the list down to one surviving row, then multiply
// that one row's columns. Comparing total output size against total input
// size (the whole list) would let this through: 40 copies of one row is
// still smaller than 50 real rows combined, even though that one row is
// far bigger than any row the list actually has. Comparing each surviving
// row against the single biggest input row catches it regardless of how
// many rows were filtered out. Covers run(), used by sort_by and by lists
// held whole (the test above only covers match(), the API-paged path).
test("a filter that keeps one row still refuses that row ballooning past the list's own rows", async () => {
  const bloat = Array.from({ length: 40 }, (_, i) => `a${i}: @`).join(', ');
  // sort_by on a list the API pages: goes through run() via queryInMemory.
  const sorted = await call(pods(50), {
    jmespath: `sort_by([?id=='p1'].{${bloat}}, &a0.id)`,
    limit: 100,
  });
  assert.equal(sorted.payload.code, 'invalid_jmespath');
  assert.match(
    String(sorted.payload.error),
    /larger than the rows of the list/
  );
  // A list held whole: run() via queryInMemory directly.
  const tool = generatedTools.find(
    (candidate) => candidate.name === 'list-gpu-types'
  )!;
  const gpus = Array.from({ length: 50 }, (_, i) => ({ id: `g${i}` }));
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async () => Response.json({ gpus }),
  });
  const result = (await dispatchGeneratedTool(api, tool, {
    jmespath: `[?id=='g1'].{${bloat}}`,
    limit: 100,
  })) as Result;
  assert.equal(result.ok, false);
  assert.equal((result.payload as Row).code, 'invalid_jmespath');
  assert.match(
    String((result.payload as Row).error),
    /larger than the rows of the list/
  );
});

test('the size guard compares bytes, not UTF-16 length: a multi-byte field cannot trade for a bigger ASCII one', () => {
  const schema = listPods.list!.rowSchema;
  // In UTF-16 length, duplicating the CJK field into two columns (~8,215
  // units) is smaller than this row's own length (name + env.MESSAGE,
  // ~8,341 units, dominated by the ASCII name), so a length-based guard lets
  // it through; in bytes (each 界 is 3) it is far larger (~24,615 vs
  // ~16,541), past the real page budget.
  const cjk = '界'.repeat(4100);
  const row = { id: 'x', name: 'a'.repeat(4200), env: { MESSAGE: cjk } };
  const q = compileListQuery('[].{a: env.MESSAGE, b: env.MESSAGE}', schema);
  assert.ok(q.ok && q.query, JSON.stringify(q));
  const out = q.query!.run([row]);
  assert.equal(out.ok, false, JSON.stringify(out));
});

test('map with a missing argument is a clean runtime 400, not an uncaught exception', () => {
  const schema = listPods.list!.rowSchema;
  const q = compileListQuery('[?map(&key)]', schema);
  assert.ok(q.ok && q.query, JSON.stringify(q));
  const out = q.query!.match({ id: 'x' });
  assert.equal(out.ok, false, JSON.stringify(out));
  assert.equal(!out.ok && out.payload.code, 'invalid_jmespath');
});

test("map's expression is checked against what it produces, not the array's own items", () => {
  const schema = listPods.list!.rowSchema;
  // tags is {key: string}[]; mapping it to {k: key}[] and then reading .k
  // must check against the mapped shape (which has k), not the original
  // tag shape (which has key, not k).
  const q = compileListQuery("[?map(&{k: key}, tags)[0].k == 'team']", schema);
  assert.ok(q.ok, JSON.stringify(q));
});

test('the patched library matches a prefix anywhere it recurs, and max_by/min_by work on text keys', async () => {
  // Patched bugs in jmespath 0.16.0 itself, not our own code: starts_with
  // used lastIndexOf (the LAST occurrence), so a name containing its own
  // prefix twice (gpu-gpu) wrongly failed to match; max_by/min_by seeded
  // their running value with +/-Infinity and compared with a raw >/<, which
  // coerces a string key to NaN, so a text key never won against the seed.
  const all = pods(3, (i) => ({
    name: i === 0 ? 'gpu-gpu' : `pod-${i}`,
    tags: [{ key: i === 0 ? 'team' : `z${i}` }],
  }));
  const started = await call(all, {
    jmespath: "[?starts_with(name, 'gpu')].{id: id}",
  });
  assert.deepEqual(started.payload.pods, [{ id: 'p0' }]);
  const maxed = await call(all, {
    jmespath: "[?max_by(tags, &key).key == 'team'].{id: id}",
  });
  assert.deepEqual(maxed.payload.pods, [{ id: 'p0' }]);
});

test('fields checked against the schema: free-form maps and output columns are fine', () => {
  const schema = listPods.list!.rowSchema;
  assert.ok(
    compileListQuery(
      'x'.repeat(0) + `[?${'id'.padEnd(JMESPATH_MAX_LENGTH - 3)}]`,
      schema
    ).ok,
    'exactly 500 characters'
  );
  // A map with known fields that also allows any key.
  const mixed: RowSchema = {
    type: 'object',
    properties: { m: { type: 'object', properties: { a: {} }, open: true } },
  };
  assert.ok(compileListQuery('[?m.zzz]', mixed).ok);
  const gpus = generatedTools.find((tool) => tool.name === 'list-gpu-types')!
    .list!.rowSchema;
  const quoted = compileListQuery("[?secure == 'true']", gpus);
  assert.ok(!quoted.ok && /true or false/.test(String(quoted.payload.error)));
  for (const expression of [
    '[?status != `null`]',
    '[?env.*]',
    "[?env.MODE == 'a']",
    '[?env.ANY_KEY_AT_ALL]',
    'sort_by([?cost != `null`].{c: cost, id: id}, &c)',
    'reverse(sort_by(@, &createdAt))',
    "[?createdAt > '2026-06-01'].{id: id}",
    '[*].{id: id, gpu: gpu.id}',
    '[].{id: id}',
    "[?tags[?key=='team']]",
    "[?contains(name, 'gpu') && !(status == 'EXITED') || cost >= `1`]",
  ])
    assert.ok(compileListQuery(expression, schema).ok, expression);
});

// Agents often start from the key the rows come back under, as other MCP
// servers' JMESPath arguments expect; a real agent did so in the e2e run.
test('a leading rows key is the rows: pods[?...] works like [?...]', async () => {
  const all = pods(150);
  for (const [prefixed, plain] of [
    ["pods[?status=='RUNNING'].{id: id}", "[?status=='RUNNING'].{id: id}"],
    ['pods[].{id: id}', '[].{id: id}'],
    ['reverse(sort_by(pods, &id))', 'reverse(sort_by(@, &id))'],
    [
      'sort_by(pods[?cost != `null`], &cost)',
      'sort_by([?cost != `null`], &cost)',
    ],
  ]) {
    const a = await call(all, { jmespath: prefixed, limit: 100 });
    const b = await call(all, { jmespath: plain, limit: 100 });
    assert.equal(
      a.result.ok,
      true,
      `${prefixed}: ${JSON.stringify(a.payload)}`
    );
    assert.deepEqual(a.payload.pods, b.payload.pods, prefixed);
  }
  const other = await call(all, { jmespath: "endpoints[?status=='RUNNING']" });
  assert.equal(other.payload.code, 'invalid_jmespath');
});

test('the rows key strips whole, not a field name it only prefixes', async () => {
  const all = pods(10);
  // "pods" is the rows key here; "podsx" is a different field name that
  // merely starts with it, and must stay a field read, not get stripped.
  const other = await call(all, { jmespath: 'podsx[?cost > `1`]' });
  assert.equal(other.payload.code, 'invalid_jmespath');
});

test('a cursor reused after changing another argument says to start without it', async () => {
  const all = pods(250);
  const first = await call(all, { jmespath: "[?status=='RUNNING']", limit: 5 });
  const cursor = (first.payload.pagination as Pagination).nextCursor;
  const reused = await call(all, {
    jmespath: "[?status=='RUNNING']",
    includeClusterPods: true,
    cursor,
  });
  assert.equal(reused.payload.code, 'invalid_cursor');
  assert.match(
    String(reused.payload.hint),
    /After changing an argument this cursor is bound to, call again without cursor/
  );
});

test('omitted, null and "" leave the list exactly as without the argument', async () => {
  const all = pods(230);
  const baseline = await call(all, { limit: 30 });
  for (const jmespath of [undefined, null, '']) {
    const run = await call(all, { limit: 30, jmespath });
    assert.deepEqual(run.payload, baseline.payload);
    assert.deepEqual(
      run.calls.map(String),
      baseline.calls.map(String),
      String(jmespath)
    );
  }
  assert.equal(baseline.calls.length, 1);
  // Pinned to the exact param set, not just compared against itself (every
  // `run` above goes through this same, post-change dispatcher too, so that
  // comparison alone can't catch a change to what the no-jmespath path
  // itself sends, such as a default argument silently added to every call).
  assert.deepEqual([...baseline.calls[0].searchParams.entries()].sort(), [
    ['limit', '30'],
  ]);
});

// ------------------------------------------------------------- the scan

test('a filtered walk returns every match once, in order, at any page size', async () => {
  // Matches are sparse and uneven, so pages end inside API pages, at their
  // ends, and across several API pages.
  const all = pods(730);
  const expression = "[?status=='RUNNING' && cost > `0.6`]";
  const expected = oracle(all, expression);
  assert.ok(expected.length > 60 && expected.length < 200);
  for (const limit of [1, 7, 20, 100]) {
    const { seen, pages } = await walk(all, { jmespath: expression, limit });
    assert.deepEqual(seen, expected, `limit ${limit}`);
    // Every row was read exactly once up to each cursor, so the scanned
    // counts add up to the list, and each note's numbers are exact.
    assert.equal(
      pages.reduce((sum, page) => sum + (page.scanned ?? 0), 0),
      all.length,
      `limit ${limit}`
    );
    for (const page of pages)
      assert.match(
        page.note!,
        new RegExp(
          page.returned
            ? `^${page.returned} of ${page.scanned} rows scanned matched\\.`
            : `^No match in the ${page.scanned} rows scanned\\.`
        )
      );
  }
});

test('a sparse filter reads at most 5 API pages per call and says an empty page is not the end', async () => {
  const all = pods(1200, (i) => ({
    name: i >= 600 ? `late-${i}` : `early-${i}`,
  }));
  const expression = "[?starts_with(name, 'late')].{id: id}";
  const first = await call(all, { jmespath: expression });
  const pagination = first.payload.pagination as Pagination;
  // Pinned to the literal 5, not the constant: a test that imports the same
  // constant it checks against can never catch the constant itself changing.
  assert.equal(MAX_SCAN_PAGES, 5);
  assert.equal(MAX_LIST_LIMIT, 100);
  assert.equal(first.calls.length, 5);
  assert.equal(pagination.returned, 0);
  assert.equal(pagination.scanned, 500);
  assert.equal(pagination.hasNextPage, true);
  assert.match(pagination.note!, /An empty page is not the end of the list/);
  assert.match(pagination.note!, /keep scanning/);
  assert.equal(pagination.total, undefined);
  const { seen } = await walk(all, { jmespath: expression });
  assert.deepEqual(seen, oracle(all, expression));
});

test('total is the match count only when one call read the whole list from its start', async () => {
  // 83 matches in 250 rows: one call of limit 100 reads all three API pages.
  const all = pods(250);
  const expression = "[?status=='EXITED'].{id: id}";
  const whole = await call(all, { jmespath: expression, limit: 100 });
  const matches = oracle(all, expression).length;
  assert.equal(matches, 83);
  assert.equal(whole.calls.length, 3);
  assert.equal((whole.payload.pagination as Pagination).total, matches);
  const partial = await call(all, { jmespath: expression, limit: 5 });
  assert.equal((partial.payload.pagination as Pagination).total, undefined);
  const big = await call(pods(900), { jmespath: expression, limit: 100 });
  assert.equal((big.payload.pagination as Pagination).total, undefined);
});

test('a page of filtered rows stays under the byte budget; one oversized row still moves on', async () => {
  const all = pods(300, (i) => ({
    notes: i === 40 ? 'x'.repeat(40_000) : 'n'.repeat(2500),
  }));
  const expression = "[?status!='STARTING']";
  const { seen, pages } = await walk(all, { jmespath: expression, limit: 100 });
  assert.deepEqual(seen, oracle(all, expression));
  assert.ok(pages.some((page) => page.returned === 1));
});

test('the resume mark is the raw row, so a change is caught even when columns drop the id', async () => {
  // Every output is {s: 'RUNNING'}: a mark taken from the output could not
  // tell rows apart.
  const all = pods(250);
  const expression = "[?status=='RUNNING'].{s: status}";
  const calls: URL[] = [];
  const api = pagedApi(all, calls);
  const first = (
    await dispatchGeneratedTool(api, listPods, {
      jmespath: expression,
      limit: 7,
    })
  ).payload as Page;
  // The last row returned is p18 (the 7th RUNNING row); delete it.
  all.splice(
    all.findIndex((row) => row.id === 'p18'),
    1
  );
  const second = (
    await dispatchGeneratedTool(api, listPods, {
      jmespath: expression,
      limit: 7,
      cursor: first.pagination.nextCursor,
    })
  ).payload as Page;
  assert.equal(second.pagination.listChanged, true);
  // Unchanged, the same cursor reports nothing.
  const fresh = pods(250);
  const again = (
    await dispatchGeneratedTool(pagedApi(fresh, []), listPods, {
      jmespath: expression,
      limit: 7,
      cursor: first.pagination.nextCursor,
    })
  ).payload as Page;
  assert.equal(again.pagination.listChanged, undefined);
});

// Agents page a list, then add a filter and keep the cursor (seen in the
// end-to-end runs). On a list the API pages a cursor is a place in the raw
// rows, so the walk continues from that row under the new expression.
test('on a list the API pages, jmespath may change between pages and the cursor continues from the same row', async () => {
  const all = pods(330);
  const rest = async (cursor: string, jmespath?: string) => {
    const rows: Row[] = [];
    let next: string | null = cursor;
    while (next) {
      const page = (await call(all, { jmespath, limit: 20, cursor: next }))
        .payload as Page;
      rows.push(...page.pods);
      next = page.pagination.nextCursor;
    }
    return rows;
  };
  // Unfiltered first, then filtered.
  const plain = (await call(all, { limit: 30 })).payload as Page;
  assert.equal(plain.pods.length, 30);
  const expression = "[?status=='RUNNING'].{id: id}";
  assert.deepEqual(
    await rest(plain.pagination.nextCursor!, expression),
    oracle(all.slice(30), expression)
  );
  // One filter, then another: the second starts after the rows the first read.
  const first = (await call(all, { jmespath: "[?status=='EXITED']", limit: 5 }))
    .payload as Page;
  const read = first.pagination.scanned!;
  assert.deepEqual(
    await rest(first.pagination.nextCursor!, expression),
    oracle(all.slice(read), expression)
  );
});

test("a cursor into an expression's result belongs to that expression", async () => {
  const all = pods(250);
  // Sorted: the cursor is an offset into the sorted rows.
  const sorted = await call(all, { jmespath: 'sort_by(@, &id)', limit: 5 });
  const cursor = (sorted.payload.pagination as Pagination).nextCursor;
  for (const args of [
    { jmespath: 'reverse(sort_by(@, &id))', cursor },
    { jmespath: "[?status=='RUNNING']", cursor },
    { cursor },
  ]) {
    const other = await call(all, args);
    assert.equal(other.payload.code, 'invalid_cursor', JSON.stringify(args));
    assert.equal(other.calls.length, 0);
  }
  // A list held whole: an offset into the matches.
  const tool = generatedTools.find(
    (candidate) => candidate.name === 'list-gpu-types'
  )!;
  const gpus = Array.from({ length: 60 }, (_, i) => ({
    id: `g${i}`,
    memory: (i % 4) * 24,
  }));
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async () => Response.json({ gpus }),
  });
  const page = (await dispatchGeneratedTool(api, tool, {
    jmespath: '[?memory >= `48`]',
    limit: 5,
  })) as Result;
  const held = (page.payload as { pagination: Pagination }).pagination
    .nextCursor;
  for (const args of [
    { jmespath: '[?memory >= `24`]', cursor: held },
    { cursor: held },
  ]) {
    const other = (await dispatchGeneratedTool(api, tool, args)) as Result;
    assert.equal(
      (other.payload as Row).code,
      'invalid_cursor',
      JSON.stringify(args)
    );
  }
});

// -------------------------------------------------------------- sorting

test('sort_by reads the whole list and pages the sorted result', async () => {
  const all = pods(420);
  const expression =
    'reverse(sort_by([?cost != `null`].{id: id, cost: cost}, &cost))';
  const expected = oracle(all, expression);
  for (const limit of [7, 100]) {
    const { seen, pages, calls } = await walk(all, {
      jmespath: expression,
      limit,
    });
    assert.deepEqual(seen, expected, `limit ${limit}`);
    assert.equal(pages[0].total, expected.length);
    assert.match(
      pages[0].note!,
      new RegExp(`^${expected.length} of 420 rows matched`)
    );
    assert.equal(
      calls.length,
      pages.length * 5,
      'each page reads the list again'
    );
  }
});

test('sort_by on more than 500 rows is refused, not sorted partly', async () => {
  const exact = await call(pods(500), {
    jmespath: 'sort_by(@, &id)',
    limit: 100,
  });
  assert.equal(exact.result.ok, true);
  const over = await call(pods(501), { jmespath: 'sort_by(@, &id)' });
  assert.equal(over.result.status, 400);
  assert.equal(over.payload.code, 'jmespath_list_too_long');
});

test('sort_by on a key some rows lack says to filter them first', async () => {
  const { payload } = await call(pods(30), { jmespath: 'sort_by(@, &cost)' });
  assert.equal(payload.code, 'invalid_jmespath');
  assert.match(
    String(payload.hint),
    /sort_by\(\[\?field != `null`\], &field\)/
  );
  const guarded = await call(pods(30), {
    jmespath: "[?starts_with(env.NONE, 'x')]",
  });
  assert.match(String(guarded.payload.hint), /guard it/);
});

// -------------------------------------------------------------- secrets

test('an expression never sees a secret env value', async () => {
  const all = pods(40);
  for (const expression of [
    "[?env.API_KEY == 'secret-3']",
    "[?starts_with(env.API_KEY, 'secret')]",
    "[?contains(to_string(@), 'secret-')]",
    // The sorted path runs on the whole list at once (ListQuery.run).
    "sort_by([?env.API_KEY == 'secret-3'], &id)",
    "sort_by([?contains(to_string(@), 'secret-')], &id)",
  ]) {
    const { payload } = await call(all, { jmespath: expression, limit: 100 });
    assert.deepEqual(payload.pods, [], expression);
  }
  const shown = await call(all, { jmespath: '[].{e: env}', limit: 3 });
  assert.equal(JSON.stringify(shown.payload).includes('secret-'), false);
  const sorted = await call(all, { jmespath: 'sort_by(@, &env.API_KEY)' });
  assert.equal(JSON.stringify(sorted.payload).includes('secret-'), false);
});

// ------------------------------------------------- lists held whole

test('a list held whole filters, chooses columns and sorts, keeping what sits beside the rows', () => {
  const schema: RowSchema = {
    type: 'object',
    properties: { id: { type: 'string' }, amount: { type: 'number' } },
  };
  const rows = Array.from({ length: 300 }, (_, i) => ({
    id: `r${i}`,
    amount: (i * 37) % 101,
  }));
  const expression =
    'reverse(sort_by([?amount > `50`].{id: id, amount: amount}, &amount))';
  const compiled = compileListQuery(expression, schema);
  assert.ok(compiled.ok && compiled.query);
  const expected = search(rows, expression) as Row[];
  const seen: Row[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i++) {
    const page = queryInMemory(
      'list-billing',
      rows,
      { jmespath: expression, limit: 30, ...(cursor ? { cursor } : {}) },
      (records, pagination) => ({
        records,
        metadata: { kept: true },
        pagination,
      }),
      20,
      compiled.query!
    );
    assert.ok(page.ok);
    const payload = page.payload as {
      records: Row[];
      metadata: Row;
      pagination: Pagination;
    };
    assert.deepEqual(payload.metadata, { kept: true });
    assert.equal(payload.pagination.total, expected.length);
    assert.match(
      payload.pagination.note!,
      new RegExp(`^${expected.length} of 300 rows matched`)
    );
    seen.push(...payload.records);
    if (!payload.pagination.hasNextPage) break;
    cursor = payload.pagination.nextCursor!;
  }
  assert.deepEqual(seen, expected);
});

test('a filtered list held whole walks page by page through dispatch', async () => {
  const tool = generatedTools.find(
    (candidate) => candidate.name === 'list-gpu-types'
  )!;
  const gpus = Array.from({ length: 60 }, (_, i) => ({
    id: `g${i}`,
    memory: (i % 4) * 24,
  }));
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async () => Response.json({ gpus }),
  });
  for (const jmespath of [
    '[?memory >= `48`].{id: id}',
    'reverse(sort_by([?memory >= `48`], &id))',
  ]) {
    const seen: unknown[] = [];
    let cursor: string | undefined;
    for (let call = 0; call < 20; call++) {
      const result = (await dispatchGeneratedTool(api, tool, {
        jmespath,
        limit: 7,
        ...(cursor ? { cursor } : {}),
      })) as Result;
      assert.ok(result.ok, JSON.stringify(result.payload));
      const page = result.payload as { gpus: Row[]; pagination: Pagination };
      seen.push(...page.gpus);
      if (!page.pagination.hasNextPage) break;
      cursor = page.pagination.nextCursor!;
    }
    assert.deepEqual(seen, search(gpus, jmespath), jmespath);
  }
});

test('a generated list held whole applies jmespath through dispatch', async () => {
  const tool = generatedTools.find(
    (candidate) => candidate.name === 'list-gpu-types'
  )!;
  const gpus = Array.from({ length: 47 }, (_, i) => ({
    id: `g${i}`,
    memory: [24, 48, 80][i % 3],
    secure: i % 2 === 0,
    price: { secure: (i % 9) + 0.5 },
  }));
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async () => Response.json({ gpus }),
  });
  const expression =
    'sort_by([?memory >= `48` && secure].{id: id, price: price.secure}, &price)';
  const result = (await dispatchGeneratedTool(api, tool, {
    jmespath: expression,
  })) as Result;
  const payload = result.payload as { gpus: Row[]; pagination: Pagination };
  assert.deepEqual(payload.gpus, search(gpus, expression));
  assert.equal(payload.pagination.total, payload.gpus.length);
});

// --------------------------------------------- hand-written lists

test('list-endpoints and list-templates return exactly their trimmed fields, and pass API errors through', async () => {
  const full = {
    id: 'e1',
    name: 'n',
    type: 'QUEUE',
    image: 'i',
    gpu: {},
    cpu: [],
    workers: {},
    scaling: {},
    dataCenterIds: [],
    flashboot: 'OFF',
    createdAt: '2026-01-01',
    serverless: true,
    env: { HF_TOKEN: 'secret', MODE: 'x' },
    requestUrls: { run: 'u' },
    readme: 'r',
    userId: 'u1',
  };
  const ctx = (answer: () => unknown) => ({
    sdk: { GET: async () => answer() },
  });
  const ok = (key: string) => () => ({
    data: {
      [key]: [full],
      pagination: { hasNextPage: false, nextCursor: null },
    },
    response: new Response(null, { status: 200 }),
  });
  const tool = (name: string) =>
    curatedTools.find((candidate) => candidate.name === name)!;
  for (const [name, key, fields] of [
    [
      'list-endpoints',
      'endpoints',
      [
        'id',
        'name',
        'type',
        'image',
        'gpu',
        'cpu',
        'workers',
        'scaling',
        'dataCenterIds',
        'flashboot',
        'createdAt',
      ],
    ],
    ['list-templates', 'templates', ['id', 'name', 'image', 'serverless']],
  ] as const) {
    for (const args of [
      {},
      { jmespath: '[*]' },
      { jmespath: `${key}[?id=='e1']` },
    ]) {
      const result = await tool(name).handler(ctx(ok(key)) as never, args);
      const rows = (result.payload as Record<string, Row[]>)[key];
      assert.deepEqual(
        Object.keys(rows[0]),
        [...fields],
        `${name} ${JSON.stringify(args)}`
      );
    }
    for (const args of [{}, { jmespath: '[*]' }]) {
      const limited = await tool(name).handler(
        ctx(() => ({
          error: { detail: 'slow down' },
          response: new Response(null, { status: 429 }),
        })) as never,
        args
      );
      assert.equal(limited.status, 429, name);
      const empty = await tool(name).handler(
        ctx(() => ({
          data: {},
          response: new Response(null, { status: 200 }),
        })) as never,
        args
      );
      assert.equal(empty.status, 502, name);
    }
  }
});

test('list-endpoints and list-templates query the trimmed rows agents see', async () => {
  const endpoint = (i: number) => ({
    id: `e${i}`,
    name: i % 3 ? `vllm-${i}` : `comfy-${i}`,
    image: 'img',
    env: { HF_TOKEN: 'secret' },
    requestUrls: { run: 'x' },
    workers: { min: 0, max: i % 4 },
  });
  const all = Array.from({ length: 140 }, (_, i) => endpoint(i));
  const ctx = {
    sdk: {
      GET: async (path: string, init: { params: { query: Row } }) => {
        const { limit, cursor } = init.params.query as {
          limit: number;
          cursor?: string;
        };
        const start = cursor
          ? all.findIndex((row) => row.id === cursor) + 1
          : 0;
        const page = all
          .slice(start, start + limit)
          .map((row) =>
            path === '/v2/templates' ? { ...row, serverless: true } : row
          );
        const more = start + page.length < all.length;
        return {
          data: {
            [path === '/v2/templates' ? 'templates' : 'endpoints']: page,
            pagination: {
              hasNextPage: more,
              nextCursor: more ? page[page.length - 1].id : null,
            },
          },
          response: new Response(null, { status: 200 }),
        };
      },
    },
  };
  const tool = (name: string) =>
    curatedTools.find((candidate) => candidate.name === name)!;
  const endpoints = await tool('list-endpoints').handler(ctx as never, {
    jmespath: "[?starts_with(name, 'vllm') && workers.max > `2`].{id: id}",
    limit: 100,
  });
  const payload = endpoints.payload as {
    endpoints: Row[];
    pagination: Pagination;
  };
  const trimmed = all.map(({ env: _e, requestUrls: _r, ...rest }) => rest);
  assert.deepEqual(
    payload.endpoints,
    search(
      trimmed,
      "[?starts_with(name, 'vllm') && workers.max > `2`].{id: id}"
    )
  );
  assert.equal(payload.pagination.total, payload.endpoints.length);
  for (const field of ['env', 'requestUrls']) {
    const refused = await tool('list-endpoints').handler(ctx as never, {
      jmespath: `[?${field}]`,
    });
    assert.equal((refused.payload as Row).code, 'invalid_jmespath', field);
  }
  const templates = await tool('list-templates').handler(ctx as never, {
    jmespath: "[?contains(name, 'comfy')].{id: id, s: serverless}",
    limit: 100,
  });
  assert.equal(
    (templates.payload as { templates: Row[] }).templates.length,
    47
  );
});

// --------------------------------------------- errors mid-scan

test("an API error on a later API page is the call's error, not the end of the list", async () => {
  const limited = () =>
    Response.json({ status: 429, detail: 'rate limited' }, { status: 429 });
  for (const jmespath of [
    "[?status=='EXITED' && cost > `5`]",
    'sort_by(@, &id)',
  ]) {
    const result = (await dispatchGeneratedTool(
      pagedApi(pods(250), [], 'pods', (n) => (n === 2 ? limited() : undefined)),
      listPods,
      { jmespath, limit: 100 }
    )) as Result;
    assert.equal(result.ok, false, jmespath);
    assert.equal(result.status, 429, jmespath);
  }
});

test('a 200 with no rows array is a 502, not a confident empty match', async () => {
  const malformed = () => Response.json({ pods: null });
  const result = (await dispatchGeneratedTool(
    pagedApi(pods(10), [], 'pods', () => malformed()),
    listPods,
    { jmespath: "[?status=='RUNNING']", limit: 100 }
  )) as Result;
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
});

test('a broken API cursor is a 502 on a filtered or sorted call too', async () => {
  for (const broken of [
    // More rows but no cursor to reach them.
    () =>
      Response.json({
        pods: pods(100),
        pagination: { hasNextPage: true, nextCursor: null },
      }),
    // A cursor that leads back to the same page.
    (url: URL) =>
      Response.json({
        pods: pods(100),
        pagination: {
          hasNextPage: true,
          nextCursor: url.searchParams.get('cursor') ?? 'same',
        },
      }),
  ])
    for (const jmespath of ["[?id=='nowhere']", 'sort_by(@, &id)']) {
      const result = (await dispatchGeneratedTool(
        pagedApi([], [], 'pods', (_, url) => broken(url)),
        listPods,
        { jmespath }
      )) as Result;
      assert.equal(result.status, 502, jmespath);
      assert.match(
        JSON.stringify(result.payload),
        /no cursor that leads to them/,
        jmespath
      );
    }
});

test('the last page of a filtered walk says neither "not the end" nor "keep scanning"', async () => {
  const { pages } = await walk(pods(250), {
    jmespath: "[?id=='p3']",
    limit: 1,
  });
  const last = pages[pages.length - 1];
  assert.equal(last.hasNextPage, false);
  assert.doesNotMatch(last.note!, /not the end|keep scanning/);
  assert.equal(pages.filter((page) => page.total !== undefined).length, 0);
});

test('a sorted call refuses a foreign cursor before reading the API', async () => {
  const first = await call(pods(250), {
    jmespath: "[?status=='RUNNING']",
    limit: 5,
  });
  const cursor = (first.payload.pagination as Pagination).nextCursor;
  const sorted = await call(pods(250), { jmespath: 'sort_by(@, &id)', cursor });
  assert.equal(sorted.payload.code, 'invalid_cursor');
  assert.equal(sorted.calls.length, 0);
});

test('a list keeps its own default page size under jmespath', async () => {
  const tool = generatedTools.find(
    (candidate) => candidate.name === 'get-endpoint-request-metrics'
  )!;
  const records = Array.from({ length: 150 }, (_, i) => ({
    id: `r${i}`,
    time: `2026-11-20T${String(i % 24).padStart(2, '0')}:00:00Z`,
    requests: i,
  }));
  const result = (await dispatchGeneratedTool(
    pagedApi(records, [], 'records'),
    tool,
    { id: 'e1', jmespath: '[].{t: time}' }
  )) as Result;
  assert.equal((result.payload as { records: Row[] }).records.length, 100);
});

test("a page the budget ends at an API page's last row resumes at the next API page", async () => {
  // Two 15 KB matches, rows 99 and 150: the budget keeps only the first,
  // which is the last row of API page 1. The next call starts at page 2.
  const all = pods(250, (i) =>
    i === 99 || i === 150 ? { name: 'big', notes: 'x'.repeat(15_000) } : {}
  );
  const calls: URL[] = [];
  const api = pagedApi(all, calls);
  const args = { jmespath: "[?name=='big']", limit: 100 };
  const first = (await dispatchGeneratedTool(api, listPods, args))
    .payload as Page;
  assert.deepEqual(
    first.pods.map((row) => row.id),
    ['p99']
  );
  const before = calls.length;
  const second = (
    await dispatchGeneratedTool(api, listPods, {
      ...args,
      cursor: first.pagination.nextCursor,
    })
  ).payload as Page;
  assert.deepEqual(
    second.pods.map((row) => row.id),
    ['p150']
  );
  assert.equal(calls[before].searchParams.get('cursor'), 'p99');
});

test('a filtered page reads only the API pages it needs', async () => {
  // limit 1, first match at row 0: one API call.
  const one = await call(pods(250), {
    jmespath: "[?status=='RUNNING']",
    limit: 1,
  });
  assert.equal(one.calls.length, 1);
  // A page whose last match is the last row of an API page resumes at the
  // next API page, without reading that one again.
  const all = pods(250, (i) => ({
    name: i === 99 || i === 150 ? 'edge' : `pod-${i}`,
  }));
  const calls: URL[] = [];
  const api = pagedApi(all, calls);
  const first = (
    await dispatchGeneratedTool(api, listPods, {
      jmespath: "[?name=='edge'].{id: id}",
      limit: 1,
    })
  ).payload as Page;
  assert.deepEqual(first.pods, [{ id: 'p99' }]);
  const before = calls.length;
  const second = (
    await dispatchGeneratedTool(api, listPods, {
      jmespath: "[?name=='edge'].{id: id}",
      limit: 1,
      cursor: first.pagination.nextCursor,
    })
  ).payload as Page;
  assert.deepEqual(second.pods, [{ id: 'p150' }]);
  assert.equal(calls[before].searchParams.get('cursor'), 'p99');
});

// ------------------------------------------------------ surface

const queryable = [
  ...generatedTools.filter(
    (tool) =>
      tool.inputSchema.properties &&
      'jmespath' in (tool.inputSchema.properties as Row)
  ),
  ...curatedTools.filter(
    (tool) => 'jmespath' in ((tool.inputSchema.properties ?? {}) as Row)
  ),
];

test('37 lists take jmespath: every generated list, list-endpoints and list-templates', () => {
  const generatedLists = generatedTools.filter((tool) => tool.list);
  assert.equal(queryable.length, 37);
  assert.ok(generatedLists.every((tool) => queryable.includes(tool)));
  assert.deepEqual(
    queryable
      .filter((tool) => !('list' in tool))
      .map((tool) => tool.name)
      .sort(),
    ['list-endpoints', 'list-templates']
  );
});

test('describe-tool shows rowFields for the lists that take jmespath, and only for them', async () => {
  const served = [...curatedTools, ...generatedTools];
  const describe = createDescribeTool(() => served);
  for (const tool of served) {
    const result = await describe.handler({} as never, { name: tool.name });
    const fields = (result.payload as { rowFields?: Record<string, string> })
      .rowFields;
    assert.equal(fields !== undefined, queryable.includes(tool), tool.name);
  }
  const pods = (await describe.handler({} as never, { name: 'list-pods' }))
    .payload as {
    rowFields: Record<string, string>;
  };
  assert.equal(
    pods.rowFields.status,
    'PROVISIONING | STARTING | RUNNING | EXITED | ERROR | TERMINATED'
  );
  assert.equal(pods.rowFields.cost, 'number');
  assert.equal(pods.rowFields['gpu.id'], 'string');
  assert.equal(pods.rowFields['tags[].key'], 'string');
  assert.equal(pods.rowFields.env, 'object (any keys)');
  assert.equal(
    pods.rowFields.actions,
    'array of start | stop | restart | terminate'
  );
});

test('the directory profile serves its lists without jmespath', () => {
  for (const tool of queryable)
    if (directoryIncludes(tool.name))
      assert.ok(
        directoryOmittedInputs(tool.name).includes('jmespath'),
        tool.name
      );
});

// ------------------------------------------------- property test

// A seeded generator of the accepted forms over Pod rows, checked against
// the expression run on the whole list.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

test('property: any accepted expression, any list size and page size, walks to the whole-list answer', async () => {
  for (let seed = 1; seed <= 120; seed++) {
    const r = random(seed);
    const pick = <T>(items: T[]): T => items[Math.floor(r() * items.length)];
    const atom = () =>
      pick([
        () => `status=='${pick(STATUSES)}'`,
        () => `cost > \`${pick([0, 0.3, 0.9])}\``,
        () => 'cost != `null`',
        () => `contains(name, '${pick(['gpu', 'cpu', '1'])}')`,
        () => `starts_with(id, 'p${Math.floor(r() * 9)}')`,
        () => `gpu.count >= \`${pick([1, 2, 3])}\``,
        () => "tags[?key=='team']",
        () => `createdAt < '2026-0${pick([3, 6, 9])}'`,
      ])();
    const cond = () => {
      const a = atom();
      return pick([a, `!(${a})`, `${a} && ${atom()}`, `${a} || ${atom()}`]);
    };
    const columns = pick([
      '',
      '.{id: id}',
      '.{n: name, c: cost}',
      '.{s: status, id: id}',
    ]);
    const rowsForm = pick([`[?${cond()}]${columns}`, `[].{id: id, s: status}`]);
    const sorted = r() < 0.3;
    const key = columns.includes('id') || !columns ? 'id' : 'n';
    const expression = sorted
      ? pick([
          `sort_by(${rowsForm.startsWith('[]') ? '@' : rowsForm}, &${rowsForm.startsWith('[]') ? 'id' : key})`,
          `reverse(sort_by(${rowsForm.startsWith('[]') ? '@' : rowsForm}, &${rowsForm.startsWith('[]') ? 'id' : key}))`,
        ])
      : rowsForm;
    const size = pick([0, 1, 99, 100, 101, 250, 499, 500, 501, 1200]);
    const limit = size > 300 ? pick([20, 100]) : pick([1, 7, 20, 100]);
    const all = pods(size);
    const label = `seed ${seed}: ${expression} over ${size} rows, limit ${limit}`;
    if (sorted && size > 500) {
      const { payload } = await call(all, { jmespath: expression, limit });
      assert.equal(payload.code, 'jmespath_list_too_long', label);
      continue;
    }
    const { seen, pages } = await walk(all, { jmespath: expression, limit });
    assert.deepEqual(seen, oracle(all, expression), label);
    if (!sorted)
      assert.equal(
        pages.reduce((sum, page) => sum + (page.scanned ?? 0), 0),
        size,
        label
      );
  }
});
