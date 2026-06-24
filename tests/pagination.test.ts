import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  capListResult,
  decodeCursorOffset,
  encodeCursorOffset,
} from '../src/pagination.js';

// Parses the single text payload a list tool returns back into an object.
function parse(result: { content: Array<{ type: 'text'; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('cursor encode/decode', () => {
  it('round-trips an offset', () => {
    assert.equal(decodeCursorOffset(encodeCursorOffset(40)), 40);
  });

  it('treats an undefined cursor as offset 0', () => {
    assert.equal(decodeCursorOffset(undefined), 0);
  });

  it('treats a garbage cursor as offset 0 instead of throwing', () => {
    assert.equal(decodeCursorOffset('not-a-real-cursor'), 0);
    assert.equal(decodeCursorOffset(''), 0);
  });

  it('treats a negative offset as 0', () => {
    assert.equal(decodeCursorOffset(encodeCursorOffset(-5)), 0);
  });
});

describe('capListResult', () => {
  const makeItems = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `item-${i}` }));

  it('returns all items and no cursor when under the limit', () => {
    const out = parse(capListResult(makeItems(5), {}));
    assert.equal(out.items.length, 5);
    assert.equal(out.pagination.total, 5);
    assert.equal(out.pagination.returned, 5);
    assert.equal(out.pagination.truncated, false);
    assert.equal(out.pagination.nextCursor, null);
  });

  it('caps to the default limit and reports truncation', () => {
    const out = parse(capListResult(makeItems(50), {}));
    assert.equal(out.items.length, DEFAULT_LIST_LIMIT);
    assert.equal(out.pagination.total, 50);
    assert.equal(out.pagination.truncated, true);
    assert.ok(out.pagination.nextCursor);
  });

  it('honors an explicit limit', () => {
    const out = parse(capListResult(makeItems(50), { limit: 5 }));
    assert.equal(out.items.length, 5);
    assert.equal(out.pagination.truncated, true);
  });

  it('clamps a limit above the ceiling to MAX_LIST_LIMIT', () => {
    const out = parse(capListResult(makeItems(500), { limit: 9999 }));
    assert.equal(out.items.length, MAX_LIST_LIMIT);
  });

  it('paginates through the full list with the returned cursor', () => {
    const items = makeItems(45);
    const first = parse(capListResult(items, { limit: 20 }));
    assert.equal(first.items[0].id, 'item-0');
    assert.equal(first.items.length, 20);

    const second = parse(
      capListResult(items, { limit: 20, cursor: first.pagination.nextCursor })
    );
    assert.equal(second.items[0].id, 'item-20');
    assert.equal(second.items.length, 20);

    const third = parse(
      capListResult(items, { limit: 20, cursor: second.pagination.nextCursor })
    );
    assert.equal(third.items[0].id, 'item-40');
    assert.equal(third.items.length, 5);
    assert.equal(third.pagination.truncated, false);
    assert.equal(third.pagination.nextCursor, null);
  });

  it('handles an empty list', () => {
    const out = parse(capListResult([], {}));
    assert.equal(out.items.length, 0);
    assert.equal(out.pagination.total, 0);
    assert.equal(out.pagination.truncated, false);
  });

  it('passes non-array results through untouched (no envelope)', () => {
    const errorShape = { error: 'something went wrong' };
    const out = parse(capListResult(errorShape, {}));
    assert.deepEqual(out, errorShape);
    assert.equal(out.pagination, undefined);
  });

  it('returns an empty page when the cursor is past the end', () => {
    const out = parse(
      capListResult(makeItems(10), { cursor: encodeCursorOffset(100) })
    );
    assert.equal(out.items.length, 0);
    assert.equal(out.pagination.truncated, false);
    assert.equal(out.pagination.nextCursor, null);
  });

  it('merges `extra` sibling fields alongside the capped page', () => {
    const out = parse(
      capListResult(makeItems(25), { limit: 5 }, { metadata: { total: 999 } })
    );
    assert.equal(out.items.length, 5);
    assert.equal(out.pagination.total, 25);
    assert.deepEqual(out.metadata, { total: 999 });
  });

  it('does not let `extra` shadow items/pagination', () => {
    const out = parse(
      capListResult(
        makeItems(3),
        {},
        { items: 'HACK', pagination: 'HACK', summary: 'kept' }
      )
    );
    assert.equal(Array.isArray(out.items), true);
    assert.equal(out.items.length, 3);
    assert.equal(typeof out.pagination, 'object');
    assert.equal(out.summary, 'kept');
  });
});
