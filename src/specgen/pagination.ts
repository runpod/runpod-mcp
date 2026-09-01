// Client-side list caps. The REST list endpoints do not support server-side
// pagination yet, so a large account's list response can exceed an LLM's
// context window. List-shaped curated tools cap their results and report what
// was omitted; `limit`/`cursor` are shaped like the cursor pagination the
// REST API will eventually ship, so tool signatures won't change when it does.

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

// The cursor is a base64-encoded offset today; invalid values are treated as
// the start so a bad cursor never throws in an agent's face.
export function decodeCursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const offset = Number.parseInt(
      Buffer.from(cursor, 'base64').toString('utf8'),
      10
    );
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
  // Coerce, floor at 1, and cap: the low-level server never validates the
  // JSON Schema, so limit: 0 (or junk) would otherwise return an empty page
  // whose nextCursor equals the current offset — a pager that never advances.
  const requested = Number(options.limit);
  const limit = Math.min(
    Number.isFinite(requested) && requested >= 1
      ? Math.floor(requested)
      : DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT
  );
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
