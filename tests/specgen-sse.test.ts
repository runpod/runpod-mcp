// Bounded SSE snapshot: the last event is kept or dropped on whether it is
// WHOLE (ends with a blank line), never on the truncated flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectLogSnapshot,
  type SseReader,
} from '../src/specgen/clients/sse.js';

const frame = (line: string) =>
  `id: 1\ndata: ${JSON.stringify({ source: 'container', line, ts: 't' })}\n\n`;
const readerOf =
  (raw: string, truncated: boolean): SseReader =>
  async () => ({ raw, truncated });

test('a complete final event survives the byte cap', async () => {
  // The cap landed exactly on an event boundary. The old code popped on
  // `truncated` alone and turned a complete crash line into an empty result.
  const r = await collectLogSnapshot(
    readerOf(frame('FATAL: out of memory'), true),
    'https://x/logs',
    {}
  );
  assert.equal(r.truncated, true);
  assert.equal(r.count, 1);
  assert.equal(r.items[0]?.line, 'FATAL: out of memory');
});

test('a genuinely partial final event is dropped, whatever ended the read', async () => {
  const partial = frame('ok') + 'id: 2\ndata: {"line":"parti';
  for (const truncated of [true, false]) {
    const r = await collectLogSnapshot(
      readerOf(partial, truncated),
      'https://x/logs',
      {}
    );
    assert.equal(r.count, 1, `truncated=${truncated}`);
    assert.equal(r.items[0]?.line, 'ok');
  }
});

test('a trailing newline mid-event is still a partial', async () => {
  // Ends with "\n" but not a blank line: the JSON is cut, parses as { raw },
  // and the old endsWith('\n') check let it through as a real entry.
  const r = await collectLogSnapshot(
    readerOf(frame('ok') + 'data: {"line":"parti\n', false),
    'https://x/logs',
    {}
  );
  assert.equal(r.count, 1);
  assert.equal(r.items[0]?.line, 'ok');
});

test('CRLF event boundaries count as complete', async () => {
  const crlf = 'id: 1\r\ndata: {"line":"done"}\r\n\r\n';
  const r = await collectLogSnapshot(
    readerOf(crlf, true),
    'https://x/logs',
    {}
  );
  assert.equal(r.count, 1);
});
