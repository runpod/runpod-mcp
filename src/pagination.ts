// ============== LIST RESULT PAGINATION / TOKEN CAPS ==============
// The REST list endpoints do not yet support server-side pagination, so a
// large account can return a payload many times the size of an LLM's context
// window (e.g. list-templates has been observed at ~15x Claude Code's window),
// which ends the agent session. Until the REST API ships cursor pagination,
// the MCP caps list responses client-side: it returns at most `limit` items
// and reports how many were omitted so the agent knows to narrow its query.
//
// The `limit` and `cursor` parameters are shaped to match the cursor-based
// pagination the REST API will add, so the tool signatures do not change when
// server-side pagination lands; the MCP will simply forward them and surface a
// real `nextCursor` instead of the client-side offset used here.

import { z } from 'zod';

// Default and maximum number of items returned by a list tool in a single
// call. The cap is what protects the agent's context; `limit` lets a caller
// ask for fewer (or more, up to the ceiling) when they know what they want.
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

// Shared Zod parameters added to every list-* tool. Optional so existing
// callers that pass nothing keep working (they get the default page).
export const listPaginationParams = {
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIST_LIMIT)
    .optional()
    .describe(
      `Maximum number of items to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}). Use the returned nextCursor to fetch the next page.`
    ),
  cursor: z
    .string()
    .optional()
    .describe(
      'Opaque pagination cursor from a previous response (nextCursor). Omit to start from the beginning.'
    ),
};

// Decodes the opaque cursor into a numeric offset. The cursor is currently a
// base64-encoded offset; when the REST API ships real cursors this becomes a
// passthrough. Invalid cursors are treated as the start so a bad value never
// throws in an agent's face.
export function decodeCursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const offset = Number.parseInt(decoded, 10);
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

export function encodeCursorOffset(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64');
}

// Caps a list response to `limit` items starting at `cursor`, returning an
// envelope that tells the agent how much it is seeing and how to get the rest.
// Only arrays are paginated; any other shape is passed through untouched.
//
// `extra` merges sibling fields alongside `items`/`pagination` (e.g. billing
// `metadata`, an endpoint-workers `summary`) so a capped list response can still
// carry the small aggregate fields that accompany the array. Reserved keys
// (`items`, `pagination`) in `extra` are ignored so they can't shadow the cap.
export function capListResult(
  result: unknown,
  options: { limit?: number; cursor?: string },
  extra?: Record<string, unknown>
): { content: Array<{ type: 'text'; text: string }> } {
  const limit = Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const offset = decodeCursorOffset(options.cursor);

  if (!Array.isArray(result)) {
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  }

  const total = result.length;
  const page = result.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < total;

  const { items: _i, pagination: _p, ...safeExtra } = extra ?? {};
  void _i;
  void _p;

  const envelope = {
    ...safeExtra,
    items: page,
    pagination: {
      total,
      returned: page.length,
      offset,
      truncated: hasMore,
      nextCursor: hasMore ? encodeCursorOffset(nextOffset) : null,
      note: hasMore
        ? `Showing ${page.length} of ${total}. Pass cursor=nextCursor to fetch more, or narrow the query with filters.`
        : undefined,
    },
  };

  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(envelope, null, 2) },
    ],
  };
}
