// ============== LIST CONTRACT SMOKE ==============
// Walks every list tool to its end through the real MCP server (in process,
// so results are redacted and serialized exactly as an agent receives them)
// and checks the list contract (src/specgen/pagination.ts) on every page:
//
// - the result is at most PAGE_BUDGET_BYTES as sent;
// - returned equals the rows on the page, and is at most limit;
// - hasNextPage and nextCursor agree, and the walk ends;
// - a walk with no listChanged returns no row twice, and total (when present)
//   equals the rows seen;
// - walks at limit 7 and limit 100 return the same rows in the same order
//   (on lists the API pages, this re-sends an API cursor with another limit);
// - a cursor handed to another list tool is refused with invalid_cursor;
// - on a list that takes jmespath, a filtered and a sorted walk (limits 7 and
//   100) return exactly what the expression gives on the unfiltered rows,
//   and every field of a live row is in its row schema, with the schema's
//   type and enum (otherwise the field check would refuse what an agent sees).
//
// The fake run is read-only. The live run creates free test data (a
// Serverless endpoint that can never start a worker, a tag and a cost
// center attached to it, and a template, all named mcp-smoke-*) so every
// nested list has a parent, walks every list, finds the endpoint and the
// template by name with jmespath, and deletes exactly that data. A skip fails
// the run; lists the live run cannot cover are named in FAKE_ONLY_LIVE.
//
//   pnpm smoke:lists                a local fake Runpod API over several
//                                   account shapes; no key (also in pnpm test)
//   pnpm smoke:lists list-pods      only the named tools
//   RUNPOD_API_KEY=… pnpm smoke:lists --live
//                                   the key's own account (see above)
//
// Live mode runs only with --live, never because RUNPOD_API_KEY happens to
// be set.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createToolContext } from '#src/specgen/context';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { search } from 'jmespath';
import type { RowSchema } from '#src/specgen/list-query';
import { PAGE_BUDGET_BYTES } from '#src/specgen/pagination';
import { createSpecgenServer, curatedTools } from '#src/specgen/server';

type Row = Record<string, unknown>;

interface ListSpec {
  tool: string;
  rows: string;
  paged: 'api' | 'memory';
  /** Ranked by live values (stock, deploy counts): two walks can differ. */
  ranked?: true;
  /** REST path; absent for lists served from GraphQL or local data. */
  path?: string;
  /** Served by public GraphQL (the fake serves it too). */
  graphql?: true;
}

const LISTS: ListSpec[] = [
  ...generatedTools
    .filter((tool) => tool.list)
    .map((tool) => ({
      tool: tool.name,
      rows: tool.list!.rows,
      paged: tool.list!.paged,
      path: tool.path,
    })),
  {
    tool: 'list-endpoints',
    rows: 'endpoints',
    paged: 'api',
    path: '/v2/serverless',
  },
  {
    tool: 'list-templates',
    rows: 'templates',
    paged: 'api',
    path: '/v2/templates',
  },
  { tool: 'list-guides', rows: 'guides', paged: 'memory' },
  {
    tool: 'list-hub-repos',
    rows: 'repos',
    ranked: true,
    paged: 'memory',
    graphql: true,
  },
  {
    tool: 'list-public-endpoints',
    rows: 'endpoints',
    paged: 'memory',
    graphql: true,
  },
  {
    tool: 'get-capacity',
    rows: 'gpus',
    ranked: true,
    paged: 'memory',
    graphql: true,
  },
];

// The lists that take jmespath, with their rows' fields.
const ROW_SCHEMAS = new Map<string, RowSchema>([
  ...generatedTools.flatMap((tool) =>
    tool.list ? [[tool.name, tool.list.rowSchema] as const] : []
  ),
  ...curatedTools.flatMap((tool) =>
    tool.rowSchema ? [[tool.name, tool.rowSchema] as const] : []
  ),
]);

// Expressions every list's fields allow: to_string(@) reads the whole row.
const QUERIES = [
  "[?contains(to_string(@), '1')]",
  'reverse(sort_by(@, &to_string(@)))',
];

// What in a live row its schema would get wrong: a key it lacks (refused as
// unknown), a value outside its enum (refused as "never"), or another type
// (a quoted-number or text check that misfires). Free-form maps excepted.
function schemaDrift(value: unknown, schema: RowSchema, at = ''): string[] {
  if (value === null || value === undefined) return [];
  const kind = Array.isArray(value)
    ? 'array'
    : typeof value === 'object'
      ? 'object'
      : typeof value;
  if (schema.type && schema.type !== kind)
    return [`${at.slice(1)} is ${kind}, the schema says ${schema.type}`];
  if (schema.enum && !schema.enum.includes(value))
    return [`${at.slice(1)} is ${JSON.stringify(value)}, not in its enum`];
  if (Array.isArray(value))
    return value.flatMap((item) =>
      schema.items ? schemaDrift(item, schema.items, `${at}[]`) : []
    );
  if (kind !== 'object' || schema.open || !schema.properties) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    Object.hasOwn(schema.properties!, key)
      ? schemaDrift(child, schema.properties![key], `${at}.${key}`)
      : [`${`${at}.${key}`.slice(1)} is not in the schema`]
  );
}

// A list under /parent/{id}/... takes its id from the list at /parent.
const parentOf = (spec: ListSpec): ListSpec | undefined => {
  const prefix = spec.path?.split('/{id}')[0];
  return spec.path?.includes('{id}')
    ? LISTS.find((other) => other.path === prefix)
    : undefined;
};

// What the duplicate check compares: the row's id, else the whole row.
const keyOf = (row: Row): string =>
  String(row.id ?? row.endpointId ?? JSON.stringify(row));

// ------------------------------------------------------------ the walk

const LIMITS = [7, 100];
// A live account can hold thousands of audit entries: stop a walk after
// this many pages and check what was seen.
const MAX_PAGES = 40;

interface Walk {
  keys: string[];
  rows: Row[];
  pages: number;
  changed: boolean;
  partial: boolean;
  cursor?: string;
  problems: string[];
  error?: { status?: number; text: string };
}

async function walk(
  client: Client,
  spec: ListSpec,
  args: Record<string, unknown>,
  limit: number
): Promise<Walk> {
  const out: Walk = {
    keys: [],
    rows: [],
    pages: 0,
    changed: false,
    partial: false,
    problems: [],
  };
  let cursor: string | undefined;
  let total: number | undefined;
  for (;;) {
    if (out.pages >= MAX_PAGES) {
      out.partial = true;
      break;
    }
    const result = (await client.callTool({
      name: spec.tool,
      arguments: { ...args, limit, ...(cursor ? { cursor } : {}) },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    const text = result.content[0]?.text ?? '';
    if (result.isError) {
      let status: number | undefined;
      try {
        status = (JSON.parse(text) as { status?: number }).status;
      } catch {
        // not JSON: no status
      }
      if (out.pages === 0)
        out.error = { status, text: text.replace(/\s+/g, ' ').slice(0, 160) };
      else
        out.problems.push(
          `page ${out.pages + 1} failed: ${text.slice(0, 160)}`
        );
      return out;
    }
    out.pages++;
    const at = `page ${out.pages}`;
    const bytes = Buffer.byteLength(text);
    const body = JSON.parse(text) as Record<string, unknown>;
    const rows = body[spec.rows] as Row[] | undefined;
    const page = body.pagination as
      | {
          returned: number;
          total?: number;
          hasNextPage: boolean;
          nextCursor: string | null;
          listChanged?: true;
        }
      | undefined;
    if (!Array.isArray(rows) || !page) {
      out.problems.push(
        `${at}: not in the list shape (keys: ${Object.keys(body).join(', ')})`
      );
      return out;
    }
    if (bytes > PAGE_BUDGET_BYTES && rows.length > 1)
      out.problems.push(
        `${at}: ${bytes} B, over the ${PAGE_BUDGET_BYTES} B budget`
      );
    if (page.returned !== rows.length)
      out.problems.push(
        `${at}: returned ${page.returned} but ${rows.length} rows`
      );
    if (rows.length > limit)
      out.problems.push(`${at}: ${rows.length} rows over limit ${limit}`);
    if (page.hasNextPage !== (page.nextCursor !== null))
      out.problems.push(
        `${at}: hasNextPage ${page.hasNextPage} with nextCursor ${page.nextCursor}`
      );
    // A filtered page can be empty with more rows to scan; nothing else can.
    if (page.hasNextPage && rows.length === 0 && !args.jmespath)
      out.problems.push(`${at}: empty page that says more exist`);
    if (page.total !== undefined) {
      total = page.total;
    }
    if (page.listChanged) out.changed = true;
    out.keys.push(...rows.map(keyOf));
    out.rows.push(...rows);
    if (!page.hasNextPage) break;
    cursor = page.nextCursor!;
    out.cursor ??= cursor;
  }
  // total can grow while walking (rows added after the cursor); the last
  // page's total is the count to match.
  if (!out.changed) {
    const repeated = out.keys.length - new Set(out.keys).size;
    if (repeated)
      out.problems.push(
        `${repeated} row(s) returned twice with no listChanged`
      );
    if (total !== undefined && !out.partial && total !== out.keys.length)
      out.problems.push(
        `total ${total} but the walk returned ${out.keys.length}`
      );
  }
  return out;
}

type Outcome = {
  status: 'PASS' | 'FAIL' | 'SKIP' | 'FAKE';
  tool: string;
  account: string;
  detail: string;
};

async function checkList(
  client: Client,
  spec: ListSpec,
  account: string,
  args: Record<string, unknown>,
  expectChange: boolean,
  // The data changes between calls (a churn shape): the two walks see
  // different lists, so they are not compared.
  mayChange = false,
  live = false
): Promise<Outcome> {
  const walks: Walk[] = [];
  for (const limit of LIMITS) walks.push(await walk(client, spec, args, limit));
  const failed = walks.find((w) => w.error);
  if (failed) {
    const { status, text } = failed.error!;
    // A key without the scope, or a parent that vanished: not this
    // contract's failure.
    return status !== undefined && status >= 400 && status < 500
      ? {
          status: 'SKIP',
          tool: spec.tool,
          account,
          detail: `API ${status}: ${text}`,
        }
      : { status: 'FAIL', tool: spec.tool, account, detail: text };
  }
  const problems = walks.flatMap((w, i) =>
    w.problems.map((p) => `limit ${LIMITS[i]}: ${p}`)
  );
  const [small, large] = walks;
  if (
    !mayChange &&
    !small.changed &&
    !large.changed &&
    !small.partial &&
    !large.partial
  ) {
    if (JSON.stringify(small.keys) !== JSON.stringify(large.keys))
      problems.push(
        `limit 7 returned ${small.keys.length} rows, limit 100 returned ${large.keys.length}, not the same rows in the same order`
      );
  }
  if (expectChange && large.keys.length > 7 && !small.changed)
    problems.push(
      'the list changed between pages but no page said listChanged'
    );
  // A cursor belongs to its tool: list-guides (local data) must refuse it.
  const cursor = small.cursor ?? large.cursor;
  if (cursor && spec.tool !== 'list-guides') {
    const other = (await client.callTool({
      name: 'list-guides',
      arguments: { cursor },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    if (!other.isError || !other.content[0]?.text?.includes('invalid_cursor'))
      problems.push("another tool accepted this tool's cursor");
  }
  const schema = ROW_SCHEMAS.get(spec.tool);
  if (schema) {
    if (live)
      for (const drift of new Set(
        large.rows.flatMap((row) => schemaDrift(row, schema))
      ))
        problems.push(`live rows differ from the row schema: ${drift}`);
    const comparable =
      !mayChange && !small.changed && !large.changed && !large.partial;
    for (const jmespath of QUERIES) {
      const expected = comparable
        ? (search(large.rows, jmespath) as Row[])
        : undefined;
      // sort_by needs the whole list: over 500 rows on a list the API pages,
      // the call is refused instead.
      const tooLong =
        jmespath.startsWith('reverse') &&
        spec.paged === 'api' &&
        (large.partial || large.rows.length > 500);
      // Live, one page size: each filtered or sorted call reads up to five
      // API pages, and the API limits calls per minute.
      for (const limit of live ? [100] : LIMITS) {
        const filtered = await walk(client, spec, { ...args, jmespath }, limit);
        const at = `jmespath ${jmespath} at limit ${limit}`;
        if (tooLong) {
          if (!filtered.error?.text.includes('jmespath_list_too_long'))
            problems.push(`${at}: over 500 rows but not refused`);
          continue;
        }
        if (filtered.error) {
          problems.push(`${at}: ${filtered.error.text}`);
          continue;
        }
        problems.push(...filtered.problems.map((p) => `${at}: ${p}`));
        if (
          expected &&
          !filtered.changed &&
          !filtered.partial &&
          JSON.stringify(filtered.rows) !== JSON.stringify(expected)
        )
          problems.push(
            `${at}: ${filtered.rows.length} rows, the expression on the whole list gives ${expected.length}`
          );
      }
    }
  }
  const rows = Math.max(small.keys.length, large.keys.length);
  const detail = problems.length
    ? problems.join('; ')
    : `${rows} rows; pages at limit 7/100: ${small.pages}/${large.pages}` +
      (small.partial || large.partial
        ? ` (stopped at ${MAX_PAGES} pages)`
        : '') +
      (small.changed || large.changed ? ', listChanged seen' : '') +
      (schema ? ', jmespath walks match' : '');
  return {
    status: problems.length ? 'FAIL' : 'PASS',
    tool: spec.tool,
    account,
    detail,
  };
}

async function connect(apiKey: string, live = false): Promise<Client> {
  const server = createSpecgenServer(
    createToolContext({ apiKey, sdkRetry: false }),
    'smoke-lists'
  );
  const client = new Client({ name: 'smoke-lists', version: '1' });
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverEnd), client.connect(clientEnd)]);
  if (live) {
    // A live run makes hundreds of calls; the API allows a set number per
    // minute. A 429 waits and retries instead of failing the list (or the
    // cleanup, which would leave test data behind).
    const call = client.callTool.bind(client);
    client.callTool = (async (...args: Parameters<typeof call>) => {
      for (let attempt = 1; ; attempt++) {
        const result = (await call(...args)) as {
          isError?: boolean;
          content: Array<{ text?: string }>;
        };
        const limited =
          result.isError &&
          /"status": ?429/.test(result.content[0]?.text ?? '');
        if (!limited || attempt === 10) return result;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }) as typeof client.callTool;
  }
  return client;
}

// ------------------------------------------------------- fake accounts

interface Shape {
  name: string;
  count: number;
  extra?: (i: number) => Row;
  churn?: 'insert';
}

const SHAPES: Shape[] = [
  { name: 'empty', count: 0 },
  { name: 'one row', count: 1 },
  { name: 'exactly one page (20)', count: 20 },
  { name: 'one past a page (21)', count: 21 },
  {
    name: 'large (250, mixed sizes)',
    count: 250,
    extra: (i) => ({ notes: 'n'.repeat(i % 9 === 0 ? 3000 : 60) }),
  },
  {
    name: 'secret env (redaction grows rows)',
    count: 120,
    extra: () => ({
      env: Object.fromEntries(
        Array.from({ length: 30 }, (_, k) => [`TOKEN_${k}`, 'f'])
      ),
    }),
  },
  {
    name: 'one row over the budget',
    count: 5,
    extra: (i) => ({ notes: 'h'.repeat(i === 2 ? 40_000 : 10) }),
  },
  { name: 'rows added mid-walk', count: 80, churn: 'insert' },
];

// The size padding (`notes`) is also put in `name`, which the hand-written
// lists that trim their rows (list-endpoints, list-templates) keep.
const fakeRow = (spec: ListSpec, shape: Shape, i: number): Row => {
  const extra = shape.extra?.(i) ?? {};
  return {
    id: `${spec.tool}-${i}`,
    name: `${spec.tool} ${i} ${extra.notes ?? ''}`,
    ...extra,
  };
};

// The public GraphQL lists, as their tools query them: the query's root
// field, and one row the tool reads. Each tool sorts its rows (name, deploys,
// memory), so an added row (i >= 10,000) lands at the end, after the cursor.
const GRAPHQL_LISTS: Record<
  string,
  { field: string; row: (i: number, text: string) => Row }
> = {
  'list-hub-repos': {
    field: 'listings',
    row: (i, text) => ({
      id: `repo-${i}`,
      repoOwner: 'owner',
      repoName: `repo-${i}`,
      title: `Repo ${i}`,
      description: text,
      type: 'SERVERLESS',
      category: 'language',
      tags: [],
      deploys: 100_000 - i,
      listedRelease: null,
    }),
  },
  'list-public-endpoints': {
    field: 'allAiApiPublicConfigs',
    row: (i, text) => ({
      id: `config-${i}`,
      aiApiId: `ep-${i}`,
      displayName: `Endpoint ${String(i).padStart(5, '0')}`,
      modelName: 'model',
      description: text,
      metadata: '{}',
      isLive: true,
    }),
  },
  'get-capacity': {
    field: 'gpuTypes',
    row: (i) => ({
      id: `gpu-${i}`,
      displayName: `GPU ${i}`,
      memoryInGb: 100_000 - i,
      secureCloud: true,
      communityCloud: false,
      securePrice: 1,
      communityPrice: null,
      lowestPrice: {
        stockStatus: 'High',
        uninterruptablePrice: 1,
        gpuTypeCudaVersions: [],
      },
    }),
  },
};

// One fake Runpod API: every REST list and the public GraphQL lists, served
// from the current shape. Lists the API pages take limit and a cursor that
// names the last row returned, as the real API's cursor does.
function startFakeApi() {
  let shape = SHAPES[0];
  let state = new Map<string, Row[]>();
  let added = 0;
  const routes = LISTS.filter((spec) => spec.path).map((spec) => ({
    spec,
    pattern: new RegExp(`^${spec.path!.replace(/\{[^}]+\}/g, '[^/]+')}$`),
  }));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    const route = routes.find(({ pattern }) => pattern.test(url.pathname));
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    // Rows for one list, with the shape's churn applied on every call but
    // the first.
    const rowsFor = (tool: string, make: (i: number) => Row): Row[] => {
      let rows = state.get(tool);
      if (!rows) rows = Array.from({ length: shape.count }, (_, i) => make(i));
      else if (shape.churn === 'insert')
        rows = [make(10_000 + added++), make(10_000 + added++), ...rows];
      state.set(tool, rows);
      return rows;
    };
    if (url.pathname === '/graphql') {
      let query = '';
      request.on('data', (chunk) => (query += chunk));
      request.on('end', () => {
        const entry = Object.entries(GRAPHQL_LISTS).find(([, list]) =>
          query.includes(list.field)
        );
        if (!entry)
          return send(200, { errors: [{ message: 'unknown query' }] });
        const [tool, list] = entry;
        const text = (i: number) =>
          String(shape.extra?.(i).notes ?? `About ${i}.`);
        send(200, {
          data: { [list.field]: rowsFor(tool, (i) => list.row(i, text(i))) },
        });
      });
      return;
    }
    if (!route)
      return send(404, {
        status: 404,
        title: 'Not Found',
        detail: url.pathname,
      });
    const { spec } = route;
    const rows = rowsFor(spec.tool, (i) => fakeRow(spec, shape, i));
    if (spec.paged === 'memory')
      return send(200, { [spec.rows]: rows, metadata: { fake: true } });
    // The API's cursor names the last row returned (as the live audit log's
    // does), so rows added in front do not shift the next page.
    const limit = Number(url.searchParams.get('limit') ?? 1000);
    const after = url.searchParams.get('cursor');
    const found = after ? rows.findIndex((row) => row.id === after) : -1;
    // Like the real API: a cursor it did not issue, or a limit over its
    // maximum (our pages never ask for more than 100), is refused.
    if ((after && found === -1) || limit > 100)
      return send(400, { status: 400, detail: 'bad cursor or limit' });
    const start = found + 1;
    const page = rows.slice(start, start + limit);
    const more = start + page.length < rows.length;
    send(200, {
      [spec.rows]: page,
      pagination: {
        hasNextPage: more,
        nextCursor: more ? String(page[page.length - 1].id) : null,
      },
    });
  });
  return {
    listen: () =>
      new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
        )
      ),
    use(next: Shape) {
      shape = next;
      state = new Map();
      added = 0;
    },
    close: () => server.close(),
  };
}

// ---------------------------------------------------------------- main

// ------------------------------------------------------ live test data

// Lists the live run leaves to the fake API, and why.
const FAKE_ONLY_LIVE: Record<string, string> = {
  'list-cluster-pods': 'fake API only: needs an Instant Cluster, which bills',
  'list-organization-users':
    'fake API only: needs a key with membership scopes',
  'list-organization-roles':
    'fake API only: needs a key with membership scopes',
  'list-organization-invites':
    'fake API only: needs a key with membership scopes',
  'list-organization-groups':
    'fake API only: needs a key with membership scopes',
  'list-organization-group-members':
    'fake API only: needs a key with membership scopes',
};

// Creates the free rows the nested lists need: a Serverless endpoint that can
// never start a worker (max 0), a tag and a cost center it is attached to,
// and a template, all named mcp-smoke-<run>. cleanup() deletes exactly those and returns
// what it could not delete.
async function seedTestData(client: Client) {
  const run = `mcp-smoke-${Date.now().toString(36)}`;
  const ids: Record<string, string> = {};
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    const text = result.content[0]?.text ?? '';
    if (result.isError)
      throw new Error(`${name} failed: ${text.slice(0, 200)}`);
    return JSON.parse(text) as Row;
  };
  const cleanup = async (): Promise<string[]> => {
    const leftovers: string[] = [];
    const attempt = (name: string, args: Record<string, unknown>) =>
      call(name, args).catch((error: Error) =>
        leftovers.push(`${run}: ${error.message}`)
      );
    // A cost center with a resource attached cannot be deleted (409).
    if (ids['list-cost-centers'] && ids['list-endpoints'])
      await attempt('detach-cost-center-resource', {
        id: ids['list-cost-centers'],
        resourceType: 'SERVERLESS_ENDPOINT',
        resourceId: ids['list-endpoints'],
      });
    for (const [tool, remove] of [
      ['list-cost-centers', 'delete-cost-center'],
      ['list-tags', 'delete-tag'],
      ['list-endpoints', 'delete-endpoint'],
      ['list-templates', 'delete-template'],
    ] as const)
      if (ids[tool]) await attempt(remove, { id: ids[tool] });
    return leftovers;
  };
  try {
    const cpus = (await call('list-cpu-types', { limit: 1 })).cpus as Row[];
    const vcpu = [cpus[0].vcpu].flat().find((n) => typeof n === 'number') ?? 2;
    ids['list-endpoints'] = String(
      (
        await call('create-endpoint', {
          body: {
            name: run,
            type: 'QUEUE',
            image: 'python:3.12-slim',
            cpu: [{ id: cpus[0].id, vcpuCount: vcpu }],
            workers: { min: 0, max: 0 },
            scaling: { type: 'QUEUE_DELAY', queueDelay: 4 },
          },
        })
      ).id
    );
    // A template costs nothing; it gives list-templates a real row.
    ids['list-templates'] = String(
      (
        await call('create-template', {
          body: { name: run, image: 'python:3.12-slim' },
        })
      ).id
    );
    ids['list-tags'] = String(
      (await call('create-tag', { body: { key: run, value: 'smoke' } })).id
    );
    ids['list-cost-centers'] = String(
      (await call('create-cost-center', { body: { value: run } })).id
    );
    const endpoint = {
      resourceType: 'SERVERLESS_ENDPOINT',
      resourceId: ids['list-endpoints'],
    };
    await call('attach-tag-resource', { id: ids['list-tags'], ...endpoint });
    await call('attach-cost-center-resource', {
      id: ids['list-cost-centers'],
      ...endpoint,
    });
  } catch (error) {
    const leftovers = await cleanup();
    throw new Error(
      `${(error as Error).message}${leftovers.length ? `; not cleaned up: ${leftovers.join('; ')}` : ''}`
    );
  }
  return { ids, run, cleanup };
}

// The server logs every tool call to stderr; a walk makes hundreds.
const logError = console.error;
console.error = (...args: unknown[]) => {
  if (args[0] !== 'tool_call') logError(...args);
};

async function main() {
  const argv = process.argv.slice(2);
  const fake = !argv.includes('--live');
  const only = argv.filter((arg) => !arg.startsWith('--'));
  const unknown = only.filter(
    (name) => !LISTS.some((spec) => spec.tool === name)
  );
  if (unknown.length) throw new Error(`not a list tool: ${unknown.join(', ')}`);
  const selected = LISTS.filter(
    (spec) => !only.length || only.includes(spec.tool)
  );
  const outcomes: Outcome[] = [];
  const report = (outcome: Outcome) => {
    outcomes.push(outcome);
    console.log(
      `${outcome.status.padEnd(4)} ${outcome.tool.padEnd(34)} ${outcome.account.padEnd(34)} ${outcome.detail}`
    );
  };
  // Generated lists join LISTS by themselves; a hand-written one must be
  // added above, or it is never walked.
  for (const tool of curatedTools)
    if (
      (tool.name.startsWith('list-') || tool.name === 'get-capacity') &&
      !LISTS.some((spec) => spec.tool === tool.name)
    )
      report({
        status: 'FAIL',
        tool: tool.name,
        account: '-',
        detail: 'a hand-written list missing from LISTS in this script',
      });

  if (fake) {
    const api = startFakeApi();
    const base = await api.listen();
    // Every host this server can reach points at the fake, so nothing
    // leaves the machine.
    process.env.RUNPOD_API_BASE_URL = base;
    process.env.RUNPOD_PUBLIC_GRAPHQL_URL = `${base}/graphql`;
    process.env.RUNPOD_AUTHED_GRAPHQL_URL = `${base}/graphql`;
    process.env.RUNPOD_SERVERLESS_API_URL = `${base}/v2`;
    try {
      for (const shape of SHAPES) {
        api.use(shape);
        const client = await connect('fake-key');
        for (const spec of selected.filter((s) => s.path || s.graphql)) {
          const args = parentOf(spec) ? { id: 'fake-parent' } : {};
          report(
            await checkList(
              client,
              spec,
              `fake: ${shape.name}`,
              args,
              // A list held whole notices rows added between pages; a list
              // the API pages resumes after its last row, unaffected.
              // (the GraphQL lists sort added rows to the end, after it).
              shape.churn === 'insert' &&
                spec.paged === 'memory' &&
                !spec.graphql,
              shape.churn !== undefined
            )
          );
        }
        await client.close();
      }
      const client = await connect('fake-key');
      for (const spec of selected.filter((s) => !s.path && !s.graphql))
        report(await checkList(client, spec, 'local data', {}, false));
      await client.close();
    } finally {
      api.close();
    }
  } else {
    const key = process.env.RUNPOD_API_KEY;
    if (!key)
      throw new Error(
        'Live mode needs RUNPOD_API_KEY in the environment: RUNPOD_API_KEY=… pnpm smoke:lists --live'
      );
    const client = await connect(key, true);
    const created = await seedTestData(client);
    try {
      for (const spec of selected) {
        const reason = FAKE_ONLY_LIVE[spec.tool];
        if (reason) {
          report({
            status: 'FAKE',
            tool: spec.tool,
            account: 'live',
            detail: reason,
          });
          continue;
        }
        const parent = parentOf(spec);
        const id = parent && created.ids[parent.tool];
        if (parent && !id)
          report({
            status: 'FAIL',
            tool: spec.tool,
            account: 'live',
            detail: `no test ${parent.tool} row was created for it`,
          });
        else
          report(
            await checkList(
              client,
              spec,
              parent ? `live (test ${parent.tool} row)` : 'live',
              id ? { id } : {},
              false,
              // A list ranked by live values (stock, deploy counts) can
              // reorder between the two walks; their order is not compared.
              spec.ranked === true,
              true
            )
          );
      }
      // The seeded rows, found by name: jmespath on live rows.
      for (const [tool, rows] of [
        ['list-endpoints', 'endpoints'],
        ['list-templates', 'templates'],
      ] as const) {
        const result = (await client.callTool({
          name: tool,
          arguments: { jmespath: `[?name=='${created.run}'].{id: id}` },
        })) as { isError?: boolean; content: Array<{ text?: string }> };
        const body = JSON.parse(result.content[0]?.text ?? '{}') as Row;
        const found = JSON.stringify(body[rows]);
        const want = JSON.stringify([{ id: created.ids[tool] }]);
        report({
          status: !result.isError && found === want ? 'PASS' : 'FAIL',
          tool,
          account: 'live (jmespath on the test row)',
          detail: `[?name=='${created.run}'] gave ${found}, expected ${want}`,
        });
      }
    } finally {
      for (const leftover of await created.cleanup())
        report({
          status: 'FAIL',
          tool: 'cleanup',
          account: 'live',
          detail: leftover,
        });
    }
    await client.close();
  }

  const count = (status: Outcome['status']) =>
    outcomes.filter((o) => o.status === status).length;
  console.log(
    `\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped` +
      (count('FAKE') ? `, ${count('FAKE')} covered by the fake API only` : '')
  );
  // A skip means a list went untested: it fails the run like a failure.
  if (count('FAIL') || count('SKIP')) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
