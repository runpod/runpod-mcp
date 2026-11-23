// One paging contract for every list tool; docs/pagination.md explains it
// and the options weighed.
//
//   in:  limit (1-100, default 20 unless the list sets its own: the small
//        catalogs use 100), cursor (pagination.nextCursor)
//   out: { <rows>, pagination: { returned, total?, hasNextPage, nextCursor,
//          listChanged?, note? } }
//
// shortcut: a change between pages is flagged, not re-aligned, and only the
// row just before the resume point is checked, so a reorder that leaves it in
// place goes unnoticed. Resume after the marked row if agents hit repeats.

import { createHash } from 'node:crypto';
import type { ListQuery } from './list-query.js';
import { redactSecretEnv } from './redact.js';
import { serializeResult } from './serialize.js';

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

// A page's result, as sent, stays under this many UTF-8 bytes. A token covers
// at least one byte and a character at most four, so it is also at most this
// many tokens and characters. Indented result JSON measured 2.8 to 3.9 bytes
// per token, so a full page is about 6,000 to 8,500 tokens.
// docs/pagination.md compares it with MCP clients' limits on a tool result.
export const PAGE_BUDGET_BYTES = 24_000;

// The list arguments every list tool takes. A list can set its own default
// page size (the small catalogs return whole by default); the rest use 20.
export const listPaginationProperties = (
  defaultLimit: number = DEFAULT_LIST_LIMIT
) => ({
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_LIST_LIMIT,
    default: defaultLimit,
    description: `Up to this many rows per page, 1-${MAX_LIST_LIMIT} (default ${defaultLimit}); a page can hold fewer.`,
  },
  cursor: {
    type: 'string',
    description:
      'pagination.nextCursor from the previous page; omit for the first page.',
  },
});

// The server does not enforce the schema by default, so limit: 0 or junk
// must not produce an empty page that never advances.
export function clampListLimit(
  limit: unknown,
  defaultLimit: number = DEFAULT_LIST_LIMIT
): number {
  const requested = Number(limit);
  return Math.min(
    Number.isFinite(requested) && requested >= 1
      ? Math.floor(requested)
      : defaultLimit,
    MAX_LIST_LIMIT
  );
}

// An optional argument sent only because a client sends every property:
// null, "" or []. It counts as omitted, here and in dispatch.
export function isEmptyValue(value: unknown): boolean {
  return (
    value === null || value === '' || (Array.isArray(value) && !value.length)
  );
}

// Where the next page starts. In a list held whole: offset `o`. In a list
// the API pages: the API cursor `c` (absent on the first API page) and `s`,
// how many of that API page's rows were already returned. `m` marks the last
// row returned; `q` ties the cursor to the tool and arguments.
interface Position {
  o?: number;
  c?: string;
  s?: number;
  m?: string;
  q: string;
}

const CURSOR_PREFIX = 'v1.';

// jmespath is left out: on a list the API pages a cursor is a place in the
// raw rows, so an agent may add or change the expression and continue from
// it. Where a cursor is a place in the expression's result (a sort, a list
// held whole), queryKey puts the expression into the tool part instead.
const fingerprint = (tool: string, args: Record<string, unknown>): string => {
  const rest = Object.entries(args)
    .filter(
      ([key, value]) =>
        key !== 'limit' &&
        key !== 'cursor' &&
        key !== 'jmespath' &&
        value !== undefined &&
        !isEmptyValue(value)
    )
    .sort(([a], [b]) => a.localeCompare(b));
  return hash(JSON.stringify([tool, rest]), 12);
};

const hash = (text: string, length: number): string =>
  createHash('sha256').update(text).digest('base64url').slice(0, length);

// A row's mark: its id (endpointId for Public Endpoints), or the whole row
// when it has none. A row whose fields change (a Pod's status) keeps its mark.
const markOf = (row: unknown): string => {
  const { id, endpointId } = (row ?? {}) as Record<string, unknown>;
  const key = id ?? endpointId;
  return hash(
    typeof key === 'string' || typeof key === 'number'
      ? String(key)
      : JSON.stringify(row),
    8
  );
};

// Whether the row before `position` is still the one the cursor marked.
const changedBefore = (
  rows: unknown[],
  position: number,
  mark?: string
): boolean =>
  mark !== undefined &&
  // A list that shrank below the position has lost the marked row too.
  (position < 1 ||
    position > rows.length ||
    markOf(rows[position - 1]) !== mark);

// The cursor's JSON is masked before base64 (not a secret — XOR against a
// hash of a public string), so a plain decode shows no readable fields:
// given a readable cursor, agents built their own from the decoded fields
// instead of copying it (seen with GLM-5.3 on compact results). The checksum
// and argument fingerprint below catch damage and cross-tool reuse, not a
// deliberate reconstruction from source — harmless here, since a cursor only
// ever returns read-only list data the same caller could already request by
// choosing its own arguments.
const CURSOR_MASK = createHash('sha256').update('runpod-mcp cursor').digest();
export const maskCursorBytes = (bytes: Buffer): Buffer =>
  Buffer.from(
    bytes.map((byte, i) => byte ^ CURSOR_MASK[i % CURSOR_MASK.length])
  );

// The position, then a checksum of it: a cursor damaged anywhere (an agent
// copying a long string wrong) is refused instead of read as another page.
const encodeCursor = (position: Position): string => {
  const body = maskCursorBytes(Buffer.from(JSON.stringify(position))).toString(
    'base64url'
  );
  return `${CURSOR_PREFIX}${body}.${hash(body, 6)}`;
};

const INVALID_CURSOR = {
  ok: false as const,
  status: 400,
  payload: {
    code: 'invalid_cursor',
    error:
      'This cursor does not belong to this list call: it is damaged, or the tool or other arguments changed since it was issued.',
    hint: 'Pass pagination.nextCursor unchanged with the same arguments. After changing an argument this cursor is bound to, call again without cursor to start from the first page.',
  },
};

function readCursor(
  tool: string,
  args: Record<string, unknown>
): { ok: true; position?: Position } | typeof INVALID_CURSOR {
  const raw = args.cursor;
  if (raw === undefined || raw === null || raw === '') return { ok: true };
  if (typeof raw !== 'string' || !raw.startsWith(CURSOR_PREFIX))
    return INVALID_CURSOR;
  const [body, checksum] = raw.slice(CURSOR_PREFIX.length).split('.');
  if (!body || checksum !== hash(body, 6)) return INVALID_CURSOR;
  try {
    const position = JSON.parse(
      maskCursorBytes(Buffer.from(body, 'base64url')).toString('utf8')
    ) as Position;
    const count = (n: unknown) =>
      n === undefined || (Number.isInteger(n) && (n as number) >= 0);
    return position?.q === fingerprint(tool, args) &&
      count(position.o) &&
      count(position.s) &&
      (position.c === undefined || typeof position.c === 'string') &&
      (position.m === undefined || typeof position.m === 'string')
      ? { ok: true, position }
      : INVALID_CURSOR;
  } catch {
    return INVALID_CURSOR;
  }
}

// For callers that reject a bad cursor before they fetch anything.
export function cursorError(
  tool: string,
  args: Record<string, unknown>
): typeof INVALID_CURSOR | undefined {
  const cursor = readCursor(tool, args);
  return cursor.ok ? undefined : cursor;
}

// As server.ts sends a result: secret env values redacted (the placeholder
// can be longer than the value), then serializeResult.
const resultBytes = (value: unknown): number =>
  Buffer.byteLength(serializeResult(redactSecretEnv(value)));

// The most rows from the front of `rows` whose page fits the budget; at
// least one, so a single oversized row still moves the list on.
function fittingRows<T>(rows: T[], build: (page: T[]) => unknown): number {
  let low = Math.min(1, rows.length);
  let high = rows.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (resultBytes(build(rows.slice(0, middle))) <= PAGE_BUDGET_BYTES)
      low = middle;
    else high = middle - 1;
  }
  return low;
}

export type Pagination = {
  returned: number;
  total?: number;
  hasNextPage: boolean;
  nextCursor: string | null;
  listChanged?: true;
  note?: string;
  /** Filtered lists the API pages: raw rows read up to nextCursor. */
  scanned?: number;
};

const MORE = 'More results exist. Pass cursor=nextCursor to fetch them.';
const CHANGED =
  'The list changed since the previous page, so rows may repeat or be missing. For an exact read, narrow the list with filters.';

function pagination(
  returned: number,
  next: Position | null,
  changed: boolean,
  total?: number
): Pagination {
  const note = [changed && CHANGED, next && MORE].filter(Boolean).join(' ');
  return {
    returned,
    ...(total === undefined ? {} : { total }),
    hasNextPage: next !== null,
    nextCursor: next && encodeCursor(next),
    ...(changed ? { listChanged: true as const } : {}),
    ...(note ? { note } : {}),
  };
}

// The API said more rows exist but sent no cursor to reach them: an error,
// not the end of the list.
const NO_API_CURSOR = {
  ok: false as const,
  status: 502,
  payload: {
    error:
      'The Runpod API reported more results but returned no cursor that leads to them.',
    hint: 'Retry the call; if it persists, narrow the list with filters.',
  },
};

export type PageResult =
  | { ok: true; payload: Record<string, unknown> }
  | typeof INVALID_CURSOR
  | typeof NO_API_CURSOR;

type Build<T> = (page: T[], pagination: Pagination) => Record<string, unknown>;

// One page of a list this server holds whole (the API returned all of it).
export function pageInMemory<T>(
  tool: string,
  items: T[],
  args: Record<string, unknown>,
  build: Build<T>,
  defaultLimit: number = DEFAULT_LIST_LIMIT
): PageResult {
  const cursor = readCursor(tool, args);
  if (!cursor.ok) return cursor;
  const q = fingerprint(tool, args);
  const start = cursor.position?.o ?? 0;
  const changed = changedBefore(items, start, cursor.position?.m);
  const candidate = items.slice(
    start,
    start + clampListLimit(args.limit, defaultLimit)
  );
  const pageOf = (page: T[]) => {
    const end = start + page.length;
    return build(
      page,
      pagination(
        page.length,
        end < items.length
          ? { o: end, m: markOf(page[page.length - 1]), q }
          : null,
        changed,
        items.length
      )
    );
  };
  const page = candidate.slice(0, fittingRows(candidate, pageOf));
  return { ok: true, payload: pageOf(page) };
}

// The request for one page of a list the API pages. Resuming inside an API
// page the budget cut, it re-sends that API page's cursor with room for the
// rows already returned plus a full page (the API accepts a larger limit on
// the same cursor, seen live), and skips the rows already returned.
export type ApiPageRequest = {
  ok: true;
  query: { limit: number; cursor?: string };
  /** Rows this page may hold (the agent's limit, or the list's default). */
  limit: number;
  skip: number;
  mark?: string;
  q: string;
};

export function apiPageRequest(
  tool: string,
  args: Record<string, unknown>,
  defaultLimit: number = DEFAULT_LIST_LIMIT
): ApiPageRequest | typeof INVALID_CURSOR {
  const cursor = readCursor(tool, args);
  if (!cursor.ok) return cursor;
  const skip = cursor.position?.s ?? 0;
  const apiCursor = cursor.position?.c;
  const limit = clampListLimit(args.limit, defaultLimit);
  return {
    ok: true,
    query: {
      limit: Math.min(skip + limit, MAX_LIST_LIMIT),
      ...(apiCursor ? { cursor: apiCursor } : {}),
    },
    limit,
    skip,
    mark: cursor.position?.m,
    q: fingerprint(tool, args),
  };
}

// One page from an API page: the rows not yet returned, cut to limit and the
// budget. The next cursor continues inside this API page while rows of it are
// left, then at the API's next page.
export function pageFromApi<T>(
  rows: T[],
  api: { hasNextPage?: boolean; nextCursor?: string | null } | undefined,
  request: ApiPageRequest,
  build: Build<T>
): PageResult {
  // More rows but no way to reach them, or a cursor back to this same page
  // (the walk would never end): an API error, not a page.
  if (
    api?.hasNextPage === true &&
    (!api.nextCursor || api.nextCursor === request.query.cursor)
  )
    return NO_API_CURSOR;
  const { skip, q, query, limit } = request;
  // Only a re-read API page (skip > 0) can have shifted under the cursor.
  const changed = skip > 0 && changedBefore(rows, skip, request.mark);
  const candidate = rows.slice(skip, skip + limit);
  const pageOf = (page: T[]) => {
    const used = skip + page.length;
    const next: Position | null =
      used < rows.length
        ? {
            ...(query.cursor ? { c: query.cursor } : {}),
            s: used,
            m: markOf(page[page.length - 1]),
            q,
          }
        : api?.hasNextPage && api.nextCursor
          ? { c: api.nextCursor, q }
          : null;
    return build(page, pagination(page.length, next, changed));
  };
  const page = candidate.slice(0, fittingRows(candidate, pageOf));
  return { ok: true, payload: pageOf(page) };
}

// ---- jmespath on lists (src/specgen/list-query.ts, docs/list-queries.md) ----

// At most this many API pages (of 100 rows) are read per call when a list the
// API pages is filtered: enough to fill a page from a sparse filter, bounded
// so one call stays a few seconds.
export const MAX_SCAN_PAGES = 5;

const SCAN_MORE =
  'More rows remain: call again with cursor=nextCursor and the same jmespath to keep scanning before concluding a match is absent.';

type ApiPagination = { hasNextPage?: boolean; nextCursor?: string | null };
export type FetchedPage<T> =
  | { ok: true; rows: T[]; api?: ApiPagination }
  | { ok: false; status: number; payload: unknown };
export type FetchPage<T> = (query: {
  limit: number;
  cursor?: string;
}) => Promise<FetchedPage<T>>;
type Failure = { ok: false; status: number; payload: unknown };

const withNote = (pagination: Pagination, lead: string, extra = {}) => ({
  ...pagination,
  ...extra,
  note: [lead, pagination.note].filter(Boolean).join(' '),
});

/** One page of a list the API pages, filtered, shaped or sorted by
 *  `query` when there is one. */
export async function listFromApi<T>(
  tool: string,
  args: Record<string, unknown>,
  fetchPage: FetchPage<T>,
  build: Build<unknown>,
  defaultLimit: number = DEFAULT_LIST_LIMIT,
  query?: ListQuery
): Promise<PageResult | Failure> {
  if (!query) {
    const request = apiPageRequest(tool, args, defaultLimit);
    if (!request.ok) return request;
    const fetched = await fetchPage(request.query);
    if (!fetched.ok) return fetched;
    return pageFromApi(fetched.rows, fetched.api, request, build);
  }
  return query.mode === 'sorted'
    ? sortedFromApi(tool, args, fetchPage, build, defaultLimit, query)
    : scanFromApi(tool, args, fetchPage, build, defaultLimit, query);
}

// A cursor into an expression's result belongs to that expression.
const queryKey = (tool: string, args: Record<string, unknown>) =>
  `${tool} jmespath=${String(args.jmespath)}`;

/** cursorError for a list held whole, with or without a query. */
export const listCursorError = (
  tool: string,
  args: Record<string, unknown>,
  query?: ListQuery
) => cursorError(query ? queryKey(tool, args) : tool, args);

/** A list held whole, through `query`: run once on every row, then paged. */
export function queryInMemory<T>(
  tool: string,
  items: T[],
  args: Record<string, unknown>,
  build: Build<unknown>,
  defaultLimit: number = DEFAULT_LIST_LIMIT,
  query: ListQuery
): PageResult | Failure {
  const result = query.run(items);
  if (!result.ok) return result;
  const lead = `${result.rows.length} of ${items.length} rows matched.`;
  return pageInMemory(
    queryKey(tool, args),
    result.rows,
    args,
    (page, pagination) =>
      build(
        page,
        withNote(
          pagination,
          pagination.hasNextPage
            ? `${lead} Send the same jmespath with cursor=nextCursor.`
            : lead
        )
      ),
    defaultLimit
  );
}

// Sorting needs every row: read the list from its start, at most
// MAX_SCAN_PAGES API pages, then page the sorted result like a list held
// whole (an offset cursor; each page reads the list again).
async function sortedFromApi<T>(
  tool: string,
  args: Record<string, unknown>,
  fetchPage: FetchPage<T>,
  build: Build<unknown>,
  defaultLimit: number,
  query: ListQuery
): Promise<PageResult | Failure> {
  const bad = listCursorError(tool, args, query);
  if (bad) return bad;
  const all: T[] = [];
  let cursor: string | undefined;
  for (let pages = 0; ; pages++) {
    if (pages === MAX_SCAN_PAGES)
      return {
        ok: false,
        status: 400,
        payload: {
          code: 'jmespath_list_too_long',
          error: `sort_by needs the whole list, and this list has more than ${MAX_SCAN_PAGES * MAX_LIST_LIMIT} rows.`,
          hint: 'Filter without sort_by and compare the matches yourself, or narrow the list with its other arguments first.',
        },
      };
    const fetched = await fetchPage({
      limit: MAX_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!fetched.ok) return fetched;
    const { api } = fetched;
    if (
      api?.hasNextPage === true &&
      (!api.nextCursor || api.nextCursor === cursor)
    )
      return NO_API_CURSOR;
    all.push(...fetched.rows);
    if (!api?.hasNextPage) break;
    cursor = api.nextCursor as string;
  }
  return queryInMemory(tool, all, args, build, defaultLimit, query);
}

// Row by row: read API pages from the cursor, keep the rows that match, and
// stop once a page is full or MAX_SCAN_PAGES API pages were read. The cursor
// always counts raw API rows, so a projection without `id` resumes right.
async function scanFromApi<T>(
  tool: string,
  args: Record<string, unknown>,
  fetchPage: FetchPage<T>,
  build: Build<unknown>,
  defaultLimit: number,
  query: ListQuery
): Promise<PageResult | Failure> {
  const request = apiPageRequest(tool, args, defaultLimit);
  if (!request.ok) return request;
  const { limit, q } = request;
  const fromStart = request.query.cursor === undefined && request.skip === 0;
  type Match = { out: unknown; page: number; index: number; raw: T };
  const matches: Match[] = [];
  // Per API page read: its cursor, the first row read, and its length.
  const pages: { cursor?: string; from: number; length: number }[] = [];
  let cursor = request.query.cursor;
  let from = request.skip;
  let next: string | null = null;
  let changed = false;
  while (pages.length < MAX_SCAN_PAGES) {
    const fetched = await fetchPage({
      limit: MAX_LIST_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    if (!fetched.ok) return fetched;
    const { rows, api } = fetched;
    if (
      api?.hasNextPage === true &&
      (!api.nextCursor || api.nextCursor === cursor)
    )
      return NO_API_CURSOR;
    if (!pages.length && from > 0)
      changed = changedBefore(rows, from, request.mark);
    for (let index = from; index < rows.length; index++) {
      const matched = query.match(rows[index]);
      if (!matched.ok) return matched;
      if (matched.out !== undefined)
        matches.push({
          out: matched.out,
          page: pages.length,
          index,
          raw: rows[index],
        });
    }
    pages.push({ cursor, from, length: rows.length });
    next = api?.hasNextPage ? (api.nextCursor as string) : null;
    if (matches.length >= limit || next === null) break;
    cursor = next;
    from = 0;
  }
  const read = (upTo: number, lastIndex?: number) =>
    pages
      .slice(0, upTo + 1)
      .reduce(
        (sum, page, at) =>
          sum +
          Math.max(
            (at === upTo && lastIndex !== undefined
              ? lastIndex + 1
              : page.length) - page.from,
            0
          ),
        0
      );
  const pageOf = (page: Match[]) => {
    // Matches found but not returned: resume right after the last returned
    // one. Otherwise every row read is done: resume at the API's next page.
    const last = page[page.length - 1];
    let position: Position | null = next ? { c: next, q } : null;
    if (page.length < matches.length) {
      // The last returned match ended its API page: the next one starts it.
      const after =
        last.index + 1 >= pages[last.page].length
          ? pages[last.page + 1].cursor
          : undefined;
      position = after
        ? { c: after, q }
        : {
            ...(pages[last.page].cursor ? { c: pages[last.page].cursor } : {}),
            s: last.index + 1,
            m: markOf(last.raw),
            q,
          };
    }
    const scanned =
      page.length < matches.length
        ? read(last.page, last.index)
        : read(pages.length - 1);
    const note = [
      page.length === 0 && position
        ? `No match in the ${scanned} rows scanned. An empty page is not the end of the list.`
        : `${page.length} of ${scanned} rows scanned matched.`,
      changed && CHANGED,
      position && SCAN_MORE,
    ]
      .filter(Boolean)
      .join(' ');
    return build(
      page.map((match) => match.out),
      {
        ...pagination(
          page.length,
          position,
          changed,
          fromStart && next === null ? matches.length : undefined
        ),
        scanned,
        note,
      }
    );
  };
  const candidate = matches.slice(0, limit);
  const fitted = fittingRows(candidate, pageOf);
  return { ok: true, payload: pageOf(candidate.slice(0, fitted)) };
}
