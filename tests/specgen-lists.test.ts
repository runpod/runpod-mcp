// The list contract (src/specgen/pagination.ts), rule by rule: every list
// takes limit and cursor; a page holds at most limit rows and stays under the
// size budget; walking nextCursor returns every row exactly once, in order;
// a cursor belongs to the arguments that issued it; total appears when the
// server holds the whole list.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { getTokenizer } from '@anthropic-ai/tokenizer';
import { createRunpodClient } from '@runpod/typescript-api-sdk';
import { dispatchGeneratedTool } from '#src/specgen/dispatch';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { curatedTools, SERVER_INSTRUCTIONS } from '#src/specgen/server';
import { redactSecretEnv } from '#src/specgen/redact';
import { serializeResult } from '#src/specgen/serialize';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  maskCursorBytes,
  PAGE_BUDGET_BYTES,
  pageInMemory,
  type Pagination,
} from '#src/specgen/pagination';

// ---------------------------------------------------------------- surface

const listTools = [
  ...generatedTools.filter((tool) => tool.list),
  ...curatedTools.filter(
    (tool) => tool.name.startsWith('list-') || tool.name === 'get-capacity'
  ),
];

// The lists that default to 100 rows: small catalogs agents compare across,
// and the endpoint metrics (oldest first, so 20 would drop the latest hours).
// Every other list defaults to 20. Changing a default means changing this
// set on purpose.
const DEFAULT_100 = new Set([
  'list-gpu-types',
  'list-cpu-types',
  'list-data-centers',
  'get-capacity',
  'get-endpoint-request-metrics',
  'get-endpoint-cold-start-metrics',
  'get-endpoint-worker-metrics',
]);

test('every list tool takes the shared limit and cursor', () => {
  const offenders = listTools.flatMap((tool) => {
    const { limit, cursor } = tool.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    const ok =
      limit?.minimum === 1 &&
      limit?.maximum === MAX_LIST_LIMIT &&
      limit?.default ===
        (DEFAULT_100.has(tool.name) ? 100 : DEFAULT_LIST_LIMIT) &&
      cursor?.type === 'string';
    return ok ? [] : [tool.name];
  });
  assert.deepEqual(offenders, []);
  assert.ok(listTools.length >= 36, `only ${listTools.length} lists found`);
});

test('every generated list operation is paged as a list', () => {
  const unpaged = generatedTools
    .filter((tool) => tool.operationId.startsWith('list') && !tool.list)
    .map((tool) => tool.name);
  assert.deepEqual(unpaged, []);
});

// Paging is explained by the shared arguments and each page's note, so a list
// description must not restate it, least of all in terms the contract makes
// untrue (a fixed page size, "no pagination", the API's own default).
test('no list description restates or contradicts the paging rules', () => {
  const stale =
    /complete and takes no pagination|holds `limit`|defaults to \d+|per page by default|Follow `pagination|not yet supported|one page at a time|Returns a page/i;
  const offenders = listTools.flatMap((tool) =>
    [tool.description, tool.directoryDescription]
      .filter((text): text is string => !!text && stale.test(text))
      .map(() => tool.name)
  );
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------- helpers

const bytes = (value: unknown) => Buffer.byteLength(serializeResult(value));

type Row = { id: string; text: string };
const rows = (count: number, text: (i: number) => string = () => 'x') =>
  Array.from(
    { length: count },
    (_, i): Row => ({ id: `r${i}`, text: text(i) })
  );

type Page = { rows: Row[]; pagination: Pagination };
const build = (page: Row[], pagination: Pagination) => ({
  rows: page,
  pagination,
});

function memoryPage(items: Row[], args: Record<string, unknown>): Page {
  const result = pageInMemory('t', items, args, build);
  assert.ok(result.ok, JSON.stringify(result.payload));
  return result.payload as Page;
}

// Follow nextCursor to the end; every page must fit the budget.
async function walk(
  next: (cursor?: string) => Promise<Page>,
  key: 'rows' | 'pods' = 'rows'
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let call = 0; call < 500; call++) {
    const page = await next(cursor);
    assert.ok(bytes(page) <= PAGE_BUDGET_BYTES, `page of ${bytes(page)} B`);
    const pageRows = (page as unknown as Record<string, Row[]>)[key];
    seen.push(...pageRows.map((row) => row.id));
    assert.equal(page.pagination.returned, pageRows.length);
    assert.equal(page.pagination.listChanged, undefined, 'stable list');
    if (!page.pagination.hasNextPage) {
      assert.equal(page.pagination.nextCursor, null);
      return seen;
    }
    cursor = page.pagination.nextCursor as string;
  }
  throw new Error('the cursor never reached the end');
}

// ------------------------------------------------- lists the server holds

test('a small catalog returns up to 100 rows by default, other lists 20', async () => {
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async () => Response.json({ gpus: rows(60), records: rows(60) }),
  });
  const byName = (name: string) =>
    generatedTools.find((tool) => tool.name === name)!;
  const gpus = (await dispatchGeneratedTool(api, byName('list-gpu-types'), {}))
    .payload as { gpus: Row[]; pagination: Pagination };
  assert.equal(gpus.gpus.length, 60);
  assert.equal(gpus.pagination.hasNextPage, false);
  const billing = (await dispatchGeneratedTool(api, byName('list-billing'), {}))
    .payload as { records: Row[]; pagination: Pagination };
  assert.equal(billing.records.length, DEFAULT_LIST_LIMIT);
});

test('limit is a maximum with a default of 20, coerced into 1-100', () => {
  const items = rows(250);
  assert.equal(memoryPage(items, {}).rows.length, DEFAULT_LIST_LIMIT);
  assert.equal(memoryPage(items, { limit: 5 }).rows.length, 5);
  assert.equal(memoryPage(items, { limit: 5000 }).rows.length, MAX_LIST_LIMIT);
  assert.equal(memoryPage(items, { limit: 0 }).rows.length, DEFAULT_LIST_LIMIT);
  assert.equal(
    memoryPage(items, { limit: 'junk' }).rows.length,
    DEFAULT_LIST_LIMIT
  );
});

test('total reports the whole list, so a first page shows how much exists', () => {
  const page = memoryPage(rows(49), {});
  assert.equal(page.pagination.total, 49);
  assert.equal(page.pagination.returned, 20);
  assert.equal(
    memoryPage(rows(49), { limit: 100 }).pagination.hasNextPage,
    false
  );
});

test('walking the cursor returns every row once, in order, at any page size', async () => {
  // Mixed row sizes, so the budget cuts some pages short of limit.
  const items = rows(300, (i) => 'y'.repeat(i % 7 === 0 ? 3000 : 40));
  for (const limit of [1, 7, 20, 100]) {
    const seen = await walk(async (cursor) =>
      memoryPage(items, { limit, cursor })
    );
    assert.deepEqual(
      seen,
      items.map((row) => row.id),
      `limit ${limit}`
    );
  }
});

test('a page stops at the size budget and continues where it stopped', async () => {
  const big = rows(100, () => 'z'.repeat(2000));
  const first = memoryPage(big, { limit: 100 });
  assert.ok(first.rows.length < 100, 'the budget cuts the page');
  assert.ok(bytes(first) <= PAGE_BUDGET_BYTES);
  const second = memoryPage(big, {
    limit: 100,
    cursor: first.pagination.nextCursor,
  });
  assert.equal(second.rows[0].id, `r${first.rows.length}`);
});

test('a page is measured as sent, after secret env values are redacted', () => {
  // "f" grows to "[redacted]" on the way out: 100 such rows measure far
  // smaller before redaction than after.
  const items = Array.from({ length: 100 }, (_, i) => ({
    id: `r${i}`,
    env: Object.fromEntries(
      Array.from({ length: 30 }, (_, k) => [`TOKEN_${k}`, 'f'])
    ),
  }));
  const result = pageInMemory(
    't',
    items,
    { limit: 100 },
    (page, pagination) => ({
      rows: page,
      pagination,
    })
  );
  assert.ok(result.ok);
  const sent = Buffer.byteLength(
    serializeResult(redactSecretEnv(result.payload))
  );
  assert.ok(sent <= PAGE_BUDGET_BYTES, `sent ${sent} B`);
});

test('a single row larger than the budget is still returned on its own', async () => {
  const items = [
    ...rows(2),
    { id: 'huge', text: 'h'.repeat(PAGE_BUDGET_BYTES * 2) },
    ...rows(2).map((row) => ({ ...row, id: `${row.id}-after` })),
  ];
  const seen: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = memoryPage(items, { cursor });
    seen.push(...page.rows.map((row) => row.id));
    if (!page.pagination.hasNextPage) break;
    cursor = page.pagination.nextCursor as string;
  }
  assert.deepEqual(
    seen,
    items.map((row) => row.id)
  );
});

test('an empty list is one empty page', () => {
  const page = memoryPage([], {});
  assert.deepEqual(page.pagination, {
    returned: 0,
    total: 0,
    hasNextPage: false,
    nextCursor: null,
  });
});

test('a cursor belongs to the arguments that issued it', () => {
  const items = rows(50);
  const first = memoryPage(items, { status: 'RUNNING' });
  const cursor = first.pagination.nextCursor;

  // A different page size is fine.
  assert.equal(
    memoryPage(items, { status: 'RUNNING', limit: 5, cursor }).rows[0].id,
    'r20'
  );
  // Different filters, a damaged cursor, or someone else's cursor: an
  // explicit error, never a silent wrong page.
  for (const args of [
    { status: 'EXITED', cursor },
    { status: 'RUNNING', cursor: `${cursor}x` },
    // One character changed in the middle, as an agent might copy it.
    {
      status: 'RUNNING',
      cursor: (cursor as string).replace(
        /^(.{10})(.)/,
        (_, head, c) => head + (c === 'A' ? 'B' : 'A')
      ),
    },
    { status: 'RUNNING', cursor: 'c2VydmVy' },
  ]) {
    const result = pageInMemory('t', items, args, build);
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal((result as { status: number }).status, 400);
    assert.equal(
      (result.payload as { code?: string }).code,
      'invalid_cursor',
      'agents can branch on the code'
    );
  }
  // An empty cursor (strict clients send every property) is the first page.
  assert.equal(
    memoryPage(items, { status: 'RUNNING', cursor: '' }).rows[0].id,
    'r0'
  );
});

test('a cursor from one list is refused by another, even with the same arguments', () => {
  const items = rows(50);
  const fromPods = pageInMemory('list-pods', items, {}, build);
  assert.ok(fromPods.ok);
  const cursor = (fromPods.payload as Page).pagination.nextCursor;
  const other = pageInMemory('list-clusters', items, { cursor }, build);
  assert.equal(other.ok, false);
  assert.equal((other as { status: number }).status, 400);
});

test('rows added or removed before the cursor are flagged', () => {
  for (const [change, edit] of [
    [
      'two rows added at the front',
      (items: Row[]) =>
        items.unshift(...rows(2).map((r) => ({ ...r, id: `new-${r.id}` }))),
    ],
    ['three earlier rows removed', (items: Row[]) => items.splice(3, 3)],
    ['the last row seen removed', (items: Row[]) => items.splice(19, 1)],
    ['the list reversed', (items: Row[]) => items.reverse()],
  ] as const) {
    const items = rows(50);
    const first = memoryPage(items, {});
    assert.equal(first.pagination.listChanged, undefined, change);
    edit(items);
    const second = memoryPage(items, { cursor: first.pagination.nextCursor });
    assert.equal(second.pagination.listChanged, true, change);
  }
});

test('a list that shrank below the cursor is a flagged empty page, not a crash', async () => {
  // Held whole: 25 workers, page 1 shows 20, the endpoint scales to 15.
  const items = rows(25);
  const first = memoryPage(items, {});
  items.splice(15);
  const second = memoryPage(items, { cursor: first.pagination.nextCursor });
  assert.equal(second.rows.length, 0);
  assert.equal(second.pagination.listChanged, true);
  assert.equal(second.pagination.hasNextPage, false);

  // API-paged: page 1 is cut inside the first API page, then Pods are
  // deleted, so the re-read API page is shorter than the rows returned.
  const all = rows(60, () => 'p'.repeat(2500));
  const api = pagedApi(all, []);
  const page = (await dispatchGeneratedTool(api, listPods, {}))
    .payload as Page & {
    pods: Row[];
  };
  assert.ok(page.pods.length < DEFAULT_LIST_LIMIT, 'the budget cut the page');
  all.splice(0, 58);
  const next = await dispatchGeneratedTool(api, listPods, {
    cursor: page.pagination.nextCursor,
  });
  assert.equal(next.ok, true, JSON.stringify(next.payload));
  assert.equal((next.payload as Page).pagination.listChanged, true);
});

test("a change after the cursor, or to a row's fields, is not flagged", () => {
  for (const [change, edit] of [
    [
      'rows added at the end',
      (items: Row[]) =>
        items.push(...rows(5).map((r) => ({ ...r, id: `new-${r.id}` }))),
    ],
    [
      'the last row seen changed its fields',
      (items: Row[]) => (items[19] = { ...items[19], text: 'RUNNING' }),
    ],
  ] as const) {
    const items = rows(50);
    const first = memoryPage(items, {});
    edit(items);
    const second = memoryPage(items, { cursor: first.pagination.nextCursor });
    assert.equal(second.pagination.listChanged, undefined, change);
    assert.equal(second.rows[0].id, 'r20', change);
  }
});

test('a changed list says what to do, and never to start over', () => {
  // On a list that keeps changing, "start over" would never finish.
  const items = rows(50);
  const first = memoryPage(items, {});
  items.shift();
  const second = memoryPage(items, { cursor: first.pagination.nextCursor });
  assert.match(
    second.pagination.note as string,
    /narrow the list with filters/i
  );
  assert.doesNotMatch(second.pagination.note as string, /start over/i);
  // Nor do the instructions every agent reads when it connects.
  const lists = SERVER_INSTRUCTIONS.slice(
    SERVER_INSTRUCTIONS.indexOf('LISTS.')
  );
  assert.doesNotMatch(
    lists.slice(0, lists.indexOf('\n')),
    /omit cursor|start over/i
  );
});

test('known limit: a reorder that leaves the last row seen in place is not flagged', () => {
  // src/specgen/pagination.ts shortcut: the cursor checks one row only.
  const items = rows(50);
  const first = memoryPage(items, {});
  [items[3], items[30]] = [items[30], items[3]];
  const second = memoryPage(items, { cursor: first.pagination.nextCursor });
  assert.equal(second.pagination.listChanged, undefined);
});

test('an argument sent empty and the same argument omitted are the same query', () => {
  const items = rows(50);
  const first = memoryPage(items, { search: '', regions: [] });
  const second = memoryPage(items, { cursor: first.pagination.nextCursor });
  assert.equal(second.rows[0].id, 'r20');
});

// ------------------------------------------------------ lists the API pages

type Call = { url: URL };

// A paged API like Runpod's: limit and an opaque cursor in, the page and
// { hasNextPage, nextCursor } out. The cursor names the last row returned,
// as the live audit log's does, so rows added in front do not shift it.
function pagedApi(all: Row[], calls: Call[]) {
  return createRunpodClient({
    apiKey: 'test',
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push({ url });
      const limit = Number(url.searchParams.get('limit') ?? 1000);
      const after = url.searchParams.get('cursor');
      const found = after ? all.findIndex((row) => row.id === after) : -1;
      // Like the real API: an unknown cursor or a limit over 100 is refused.
      if ((after && found === -1) || limit > MAX_LIST_LIMIT)
        return Response.json({ status: 400 }, { status: 400 });
      const start = found + 1;
      const pods = all.slice(start, start + limit);
      const more = start + pods.length < all.length;
      // The live API sends its pagination block before the rows.
      return Response.json({
        pagination: {
          hasNextPage: more,
          nextCursor: more ? pods[pods.length - 1].id : null,
        },
        pods,
      });
    },
  });
}

const listPods = generatedTools.find((tool) => tool.name === 'list-pods')!;

test('a list the API pages sends the shared page size, never the API 1000', async () => {
  const calls: Call[] = [];
  const api = pagedApi(rows(250), calls);
  await dispatchGeneratedTool(api, listPods, {});
  await dispatchGeneratedTool(api, listPods, { limit: 5000 });
  assert.equal(calls[0].url.searchParams.get('limit'), `${DEFAULT_LIST_LIMIT}`);
  assert.equal(calls[1].url.searchParams.get('limit'), `${MAX_LIST_LIMIT}`);
});

test('a list the API pages puts its rows before the pagination block, like every list', async () => {
  const result = await dispatchGeneratedTool(
    pagedApi(rows(30), []),
    listPods,
    {}
  );
  assert.ok(result.ok);
  assert.deepEqual(Object.keys(result.payload as object), [
    'pods',
    'pagination',
  ]);
});

test('walking a list the API pages returns every row once, one API call per page', async () => {
  // Large rows: the budget cuts inside API pages, so the cursor has to resume
  // in the middle of one.
  const all = rows(230, (i) => 'p'.repeat(i % 3 === 0 ? 2500 : 300));
  for (const limit of [20, 100]) {
    const calls: Call[] = [];
    const api = pagedApi(all, calls);
    let agentCalls = 0;
    const seen = await walk(async (cursor) => {
      agentCalls++;
      const result = await dispatchGeneratedTool(api, listPods, {
        limit,
        cursor,
      });
      assert.ok(result.ok, JSON.stringify(result.payload));
      const page = result.payload as Page & { pods: Row[] };
      assert.equal(
        page.pagination.total,
        undefined,
        'the API reports no total'
      );
      return page;
    }, 'pods');
    assert.deepEqual(
      seen,
      all.map((row) => row.id),
      `limit ${limit}`
    );
    assert.equal(calls.length, agentCalls, `limit ${limit}`);
  }
});

test('a Pod created while re-reading a cut API page is flagged', async () => {
  // Large rows, so the size budget cuts the first API page; the next call
  // re-reads it from the top, where the new Pod now sits.
  const all = rows(60, () => 'p'.repeat(2500));
  const api = pagedApi(all, []);
  const first = (await dispatchGeneratedTool(api, listPods, {}))
    .payload as Page & { pods: Row[] };
  assert.ok(first.pods.length < DEFAULT_LIST_LIMIT, 'the budget cut the page');
  all.unshift({ id: 'created-meanwhile', text: 'p' });
  const second = (
    await dispatchGeneratedTool(api, listPods, {
      cursor: first.pagination.nextCursor,
    })
  ).payload as Page & { pods: Row[] };
  assert.equal(second.pagination.listChanged, true);
});

test('Pods created between two API pages are not returned twice', async () => {
  // Each page is a whole API page, so the next starts at the API's cursor,
  // which names the last Pod returned: new Pods in front do not shift it.
  const all = rows(60);
  const api = pagedApi(all, []);
  const first = (await dispatchGeneratedTool(api, listPods, {}))
    .payload as Page & { pods: Row[] };
  assert.equal(first.pods.length, DEFAULT_LIST_LIMIT);
  all.unshift({ id: 'new-1', text: 'p' }, { id: 'new-2', text: 'p' });
  const second = (
    await dispatchGeneratedTool(api, listPods, {
      cursor: first.pagination.nextCursor,
    })
  ).payload as Page & { pods: Row[] };
  assert.equal(second.pods[0].id, 'r20');
  assert.equal(second.pagination.listChanged, undefined);
});

test('curated lists the server pages reject a bad cursor before fetching', async () => {
  // Any use of the context (GraphQL, REST) counts as a fetch.
  let touched = 0;
  const ctx = new Proxy({}, { get: () => (touched++, undefined) });
  for (const name of [
    'list-hub-repos',
    'list-public-endpoints',
    'get-capacity',
  ]) {
    const tool = curatedTools.find((candidate) => candidate.name === name)!;
    const result = await tool.handler(ctx as never, { cursor: 'junk' });
    assert.equal(result.status, 400, name);
  }
  assert.equal(touched, 0);
});

test('an API page that says more exist but has no cursor is an error, not the end', async () => {
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async () =>
      Response.json({
        pods: rows(3),
        pagination: { hasNextPage: true, nextCursor: null },
      }),
  });
  const result = await dispatchGeneratedTool(api, listPods, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
});

test('an API cursor that leads back to the same page is an error, not a loop', async () => {
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async () =>
      Response.json({
        pods: rows(20),
        pagination: { hasNextPage: true, nextCursor: 'same' },
      }),
  });
  const first = (await dispatchGeneratedTool(api, listPods, {}))
    .payload as Page;
  const again = await dispatchGeneratedTool(api, listPods, {
    cursor: first.pagination.nextCursor,
  });
  assert.equal(again.ok, false);
  assert.equal(again.status, 502);
});

test('the endpoint metrics reads page like every other list', () => {
  for (const name of [
    'get-endpoint-request-metrics',
    'get-endpoint-cold-start-metrics',
    'get-endpoint-worker-metrics',
  ]) {
    const tool = generatedTools.find((candidate) => candidate.name === name)!;
    assert.deepEqual(
      tool.list,
      { rows: 'records', paged: 'api', defaultLimit: 100 },
      name
    );
  }
});

test('a bad cursor on a list the API returns whole is rejected before the API call', async () => {
  const calls: Call[] = [];
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      calls.push({ url: new URL(request.url) });
      return Response.json({ records: [] });
    },
  });
  const billing = generatedTools.find(
    (tool) => tool.name === 'list-pod-billing'
  )!;
  const result = await dispatchGeneratedTool(api, billing, { cursor: 'junk' });
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);
});

test('the rows left over from a cut API page are topped up, not sent alone', async () => {
  // list-pods-sized rows: the budget cuts a 20-row API page at about 17.
  const all = rows(100, () => 'p'.repeat(1250));
  const calls: Call[] = [];
  const api = pagedApi(all, calls);
  const sizes: number[] = [];
  const seen = await walk(async (cursor) => {
    const page = (await dispatchGeneratedTool(api, listPods, { cursor }))
      .payload as Page & { pods: Row[] };
    sizes.push(page.pods.length);
    return page;
  }, 'pods');
  assert.deepEqual(
    seen,
    all.map((row) => row.id)
  );
  // Every page but the last is cut by the budget or by limit, never a
  // short leftover of the previous API page.
  const full = Math.max(...sizes);
  assert.ok(
    sizes.slice(0, -1).every((size) => size >= full - 1),
    `page sizes ${sizes}`
  );
  assert.equal(calls.length, sizes.length, 'one API call per page');
});

test('a cursor cannot set the page size sent to the API', async () => {
  const calls: Call[] = [];
  const api = pagedApi(
    rows(300, () => 'p'.repeat(2500)),
    calls
  );
  const first = (await dispatchGeneratedTool(api, listPods, {}))
    .payload as Page;
  // Re-encode the cursor with an extra page-size field and a valid
  // checksum, as a determined agent could.
  const raw = first.pagination.nextCursor as string;
  // Opaque: a plain base64 decode shows no readable fields to rebuild.
  assert.throws(() =>
    JSON.parse(
      Buffer.from(raw.slice(3).split('.')[0], 'base64url').toString('utf8')
    )
  );
  const position = JSON.parse(
    maskCursorBytes(
      Buffer.from(raw.slice(3).split('.')[0], 'base64url')
    ).toString('utf8')
  );
  const body = maskCursorBytes(
    Buffer.from(JSON.stringify({ ...position, l: 1_000_000 }))
  ).toString('base64url');
  const checksum = createHash('sha256')
    .update(body)
    .digest('base64url')
    .slice(0, 6);
  const forged = `v1.${body}.${checksum}`;
  await dispatchGeneratedTool(api, listPods, { cursor: forged });
  assert.ok(
    Number(calls[1].url.searchParams.get('limit')) <= MAX_LIST_LIMIT,
    `limit ${calls[1].url.searchParams.get('limit')}`
  );
  // A rebuilt cursor with a negative position or a non-string API cursor is
  // refused before any API call.
  const sign = (fields: Record<string, unknown>) => {
    const b = maskCursorBytes(
      Buffer.from(JSON.stringify({ ...position, ...fields }))
    ).toString('base64url');
    return `v1.${b}.${createHash('sha256').update(b).digest('base64url').slice(0, 6)}`;
  };
  for (const fields of [{ s: -5 }, { c: 1 }, { m: 7 }]) {
    const result = await dispatchGeneratedTool(api, listPods, {
      cursor: sign(fields),
    });
    assert.equal(result.status, 400, JSON.stringify(fields));
  }
  assert.equal(calls.length, 2, 'no API call for a refused cursor');
});

test('the API cursor never reaches the agent, and a bad cursor never reaches the API', async () => {
  const calls: Call[] = [];
  const api = pagedApi(rows(50), calls);
  const first = (await dispatchGeneratedTool(api, listPods, {}))
    .payload as Page;
  assert.match(first.pagination.nextCursor as string, /^v1\./);
  const bad = await dispatchGeneratedTool(api, listPods, { cursor: '20' });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(calls.length, 1, 'the API was not called with a bad cursor');
});

test('a list the API returns whole is paged here and keeps its other fields', async () => {
  const calls: Call[] = [];
  const records = Array.from({ length: 45 }, (_, i) => ({ amount: i }));
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      calls.push({ url: new URL(request.url) });
      return Response.json({ records, metadata: { currency: 'USD' } });
    },
  });
  const billing = generatedTools.find(
    (tool) => tool.name === 'list-pod-billing'
  )!;
  const first = (await dispatchGeneratedTool(api, billing, {})).payload as {
    records: unknown[];
    metadata: unknown;
    pagination: Pagination;
  };
  assert.equal(first.records.length, DEFAULT_LIST_LIMIT);
  assert.deepEqual(first.metadata, { currency: 'USD' });
  assert.equal(first.pagination.total, 45);
  assert.equal(calls[0].url.searchParams.has('limit'), false);
  assert.equal(calls[0].url.searchParams.has('cursor'), false);
});

test('an empty success from a list answers with its status, not nothing', async () => {
  const api = createRunpodClient({
    apiKey: 'test',
    fetch: async () => new Response(null, { status: 204 }),
  });
  const secrets = generatedTools.find((tool) => tool.name === 'list-secrets')!;
  const result = await dispatchGeneratedTool(api, secrets, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, { status: 204 });
});

// ----------------------------------------------------- the size guarantee

// The budget is in bytes because the server cannot count tokens. This is the
// promise it stands for, measured with the tokenizer on the text that costs
// the most tokens per byte: no page passes 25,000 tokens or 50,000
// characters, whatever the rows hold (docs/pagination.md: client limits).
test('no page passes 25,000 tokens or 50,000 characters, in any script', async () => {
  const tokenizer = getTokenizer();
  const tokens = (value: unknown) =>
    tokenizer.encode(serializeResult(value).normalize('NFKC'), 'all').length;
  const scripts = {
    'rare CJK': '龘靐齉麤鬱灪爩驫鱻',
    Japanese: '日本語のログ出力です。',
    Devanagari: 'मॉडल लोड हो रहा है ',
    'control characters': '\u0001\u0007\u000b',
    emoji: '🚀✅█▏',
  };
  for (const [name, text] of Object.entries(scripts)) {
    const items = rows(200, () => text.repeat(60));
    for (const [path, page] of [
      ['memory', memoryPage(items, { limit: 100 })],
      [
        'API',
        (
          await dispatchGeneratedTool(pagedApi(items, []), listPods, {
            limit: 100,
          })
        ).payload,
      ],
    ] as const) {
      const text = serializeResult(page);
      assert.ok(
        tokens(page) <= 25_000,
        `${name} ${path}: ${tokens(page)} tokens`
      );
      assert.ok(text.length <= 50_000, `${name} ${path}: ${text.length} chars`);
    }
  }
});

// -------------------------------------------------------- curated lists

// Every hand-written list answers in the shared shape: its rows under the
// resource's key and the shared pagination block, with total where the
// server holds the whole list.
test('every curated list answers with its rows and the shared pagination block', async () => {
  const many = (make: (i: number) => object) =>
    Array.from({ length: 25 }, (_, i) => make(i));
  const ctx = {
    sdk: {
      // Like the API: returns `limit` rows and says more exist.
      GET: async (
        _path: string,
        init: { params: { query: { limit: number } } }
      ) => ({
        data: {
          endpoints: many((i) => ({ id: `ep${i}` })).slice(
            0,
            init.params.query.limit
          ),
          templates: many((i) => ({ id: `t${i}` })).slice(
            0,
            init.params.query.limit
          ),
          pagination: { hasNextPage: true, nextCursor: 'next' },
        },
        response: new Response(null, { status: 200 }),
      }),
    },
    graphql: {
      public: async () => ({
        listings: many((i) => ({
          id: `l${i}`,
          repoOwner: 'o',
          repoName: `r${i}`,
        })),
        allAiApiPublicConfigs: many((i) => ({
          id: `pe${i}`,
          aiApiId: `a${i}`,
          modelName: `model-${i}`,
          displayName: `Model ${i}`,
          isLive: true,
        })),
        gpuTypes: many((i) => ({
          id: `GPU ${i}`,
          displayName: `GPU ${i}`,
          memoryInGb: 24,
          secureCloud: true,
          communityCloud: false,
          securePrice: 1,
          communityPrice: null,
          lowestPrice: {
            stockStatus: 'Low',
            uninterruptablePrice: 1,
            gpuTypeCudaVersions: [
              { cudaVersion: '13.2', availability: 'AVAILABLE' },
            ],
          },
        })),
      }),
    },
  } as never;
  // rows key, and whether the server holds the whole list (so: total)
  const expected: Record<string, [string, boolean]> = {
    'list-endpoints': ['endpoints', false],
    'list-templates': ['templates', false],
    'list-hub-repos': ['repos', true],
    'list-public-endpoints': ['endpoints', true],
    'list-guides': ['guides', true],
    'get-capacity': ['gpus', true],
  };
  const curatedLists = curatedTools.filter(
    (candidate) =>
      candidate.name.startsWith('list-') || candidate.name === 'get-capacity'
  );
  assert.deepEqual(
    curatedLists.map((candidate) => candidate.name).sort(),
    Object.keys(expected).sort(),
    'a new curated list needs its entry here'
  );
  for (const list of curatedLists) {
    const [key, whole] = expected[list.name];
    const result = await list.handler(ctx, {});
    assert.equal(result.ok, true, list.name);
    const payload = result.payload as Record<string, unknown> & {
      pagination: Record<string, unknown>;
    };
    const listRows = payload[key];
    assert.ok(Array.isArray(listRows), `${list.name} rows`);
    // get-capacity defaults to the whole catalog (100): all 25 fake rows on
    // one page. The others default to 20 of 25, with a next page.
    const complete = list.name === 'get-capacity';
    assert.equal(
      listRows.length,
      complete ? 25 : DEFAULT_LIST_LIMIT,
      `${list.name} page size`
    );
    assert.deepEqual(
      Object.keys(payload.pagination).sort(),
      [
        'hasNextPage',
        'nextCursor',
        ...(complete ? [] : ['note']),
        'returned',
        ...(whole ? ['total'] : []),
      ].sort(),
      `${list.name} pagination`
    );
    assert.equal(payload.pagination.hasNextPage, !complete, list.name);
    assert.ok(!('items' in payload), `${list.name} still returns items`);
  }
});
