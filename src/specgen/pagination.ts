// List caps so a large account's response cannot exceed an LLM's context
// window. Curated tools over a paginated v2 list endpoint (list-endpoints,
// list-templates) pass the server's `limit`/`cursor` through with
// serverPageQuery and return its `pagination` block via serverPagination.
// Tools whose data has no server pagination (hub, public endpoints, capacity)
// cap client-side with capList, whose cursors are offsets into one response.

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

// JSON Schema fragments for the shared list parameters (spread into a curated
// tool's inputSchema properties).
export const listPaginationProperties = {
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_LIST_LIMIT,
    description: `Maximum number of items to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}). Use the returned nextCursor to fetch the next page.`,
  },
  cursor: {
    type: 'string',
    description:
      'Opaque pagination cursor from a previous response (nextCursor). Omit to start from the beginning.',
  },
} as const;

// Coerce, floor at 1, and cap: the low-level server never validates the
// JSON Schema, so limit: 0 (or junk) would otherwise return an empty page
// whose nextCursor never advances.
export function clampListLimit(limit: unknown): number {
  const requested = Number(limit);
  return Math.min(
    Number.isFinite(requested) && requested >= 1
      ? Math.floor(requested)
      : DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT
  );
}

// Query for a server-paginated list: the capped limit, and the server's
// opaque cursor verbatim. A malformed cursor is the server's to reject (422).
export function serverPageQuery(args: Record<string, unknown>): {
  limit: number;
  cursor?: string;
} {
  const cursor =
    typeof args.cursor === 'string' && args.cursor !== ''
      ? args.cursor
      : undefined;
  return { limit: clampListLimit(args.limit), ...(cursor ? { cursor } : {}) };
}

// The server's pagination block, plus how many items this page returned.
export function serverPagination(
  pagination: { nextCursor?: string | null; hasNextPage?: boolean } | undefined,
  returned: number
): Record<string, unknown> {
  const hasNextPage = pagination?.hasNextPage === true;
  return {
    returned,
    hasNextPage,
    nextCursor: pagination?.nextCursor ?? null,
    ...(hasNextPage
      ? { note: 'More results exist. Pass cursor=nextCursor to fetch them.' }
      : {}),
  };
}

// The cursor is a base64-encoded offset today; invalid values are treated as
// the start so a bad cursor never throws in an agent's face.
export function decodeCursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    // Strict digits-only: parseInt would accept "20junk" (and Node's base64
    // decoder silently strips non-alphabet bytes first), silently paginating
    // mid-list from a mangled cursor instead of restarting.
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!/^\d+$/.test(decoded)) return 0;
    const offset = Number.parseInt(decoded, 10);
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

export function encodeCursorOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

// Caps a list to `limit` items starting at `cursor`, returning an envelope
// that tells the agent how much it is seeing and how to get the rest. `extra`
// merges small aggregate sibling fields alongside items/pagination; reserved
// keys in it are ignored so they cannot shadow the cap.
export function capList(
  items: unknown[],
  options: { limit?: number; cursor?: string },
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const limit = clampListLimit(options.limit);
  const offset = decodeCursorOffset(options.cursor);
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < total;
  const { items: _i, pagination: _p, ...safeExtra } = extra ?? {};
  void _i;
  void _p;
  return {
    ...safeExtra,
    items: page,
    pagination: {
      total,
      returned: page.length,
      offset,
      truncated: hasMore,
      nextCursor: hasMore ? encodeCursorOffset(nextOffset) : null,
      ...(hasMore
        ? {
            note: `Showing ${page.length} of ${total}. Pass cursor=nextCursor to fetch more, or narrow the query with filters.`,
          }
        : {}),
    },
  };
}
