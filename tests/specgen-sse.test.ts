// Bounded SSE snapshot: the last event is kept or dropped on whether it is
// WHOLE (ends with a blank line), never on the truncated flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectLogSnapshot,
  createSseReader,
  type SseReader,
} from '#src/specgen/clients/sse';

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

test('partial heartbeat or metadata does not discard a preceding complete log', async () => {
  for (const newline of ['\n', '\r\n']) {
    for (const tail of [
      ': heartbeat',
      'event: log',
      'id: 123',
      'retry: 1000',
      'data: {"line":"partial',
    ]) {
      for (const truncated of [false, true]) {
        const raw = `data: {"line":"container crashed"}${newline}${newline}${tail}${newline}`;
        const result = await collectLogSnapshot(
          async () => ({ raw, truncated }),
          'https://example.invalid',
          {}
        );
        assert.deepEqual(result.items, [{ line: 'container crashed' }]);
        assert.equal(result.truncated, truncated);
      }
    }
  }
});

test('SDK parser handles CR-only frames and preserves invalid log data as raw', async () => {
  const result = await collectLogSnapshot(
    readerOf('data: {"line":"hé😀"}\r\rdata: {"line":42}\r\r', false),
    'https://example.invalid/logs',
    {}
  );
  assert.deepEqual(result.items, [{ line: 'hé😀' }, { raw: '{"line":42}' }]);
});

test('snapshot byte cap bounds a single oversized network chunk', async () => {
  let cancelled = false;
  const reader = createSseReader({
    apiKey: 'test-key',
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(frame('ok') + 'x'.repeat(2_000_000))
            );
          },
          cancel() {
            cancelled = true;
          },
        })
      ),
  });
  const result = await reader('https://example.invalid/logs', {
    maxWaitMs: 1000,
    maxBytes: 100,
  });
  assert.equal(Buffer.byteLength(result.raw), 100);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test('SSE deadline returns collected frames even when the source ignores abort', async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame('ready')));
    },
  });
  const reader = createSseReader({
    apiKey: 'test-key',
    fetchImpl: async () => new Response(source),
  });
  const result = await collectLogSnapshot(
    reader,
    'https://example.invalid/logs',
    { maxWaitMs: 20 }
  );
  assert.equal(result.items[0]?.line, 'ready');
  assert.equal(source.locked, false);
});

// Headers that arrive after maxWaitMs used to fail the call as "did not
// respond": one deadline covered connecting and reading. Seen live with
// maxWaitMs 2000 against headers that took longer.
test('slow headers within the connect budget still yield a snapshot', async () => {
  const reader = createSseReader({
    apiKey: 'test-key',
    connectTimeoutMs: 1000,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(frame('late but fine'))
            );
          },
        })
      );
    },
  });
  const started = Date.now();
  const result = await collectLogSnapshot(reader, 'https://x/logs', {
    maxWaitMs: 50,
  });
  assert.deepEqual(
    result.items.map((item) => item.line),
    ['late but fine']
  );
  // The read window runs from the headers: about 150 + 50 ms, not 1000 + 50.
  assert.ok(Date.now() - started < 900, `took ${Date.now() - started} ms`);
});

test('a snapshot over the size cap keeps the leading lines that fit', async () => {
  const { fitSnapshot } = await import('#src/specgen/clients/sse');
  // Distinct timestamps, so the cut has no boundary to move to.
  const items = Array.from({ length: 500 }, (_, i) => ({
    source: 'container',
    line: `step ${i}`,
    ts: `2026-11-05T23:56:55.${String(i).padStart(9, '0')}Z`,
  }));
  const cut = fitSnapshot(items, false, 5_000);
  assert.equal(cut.truncated, true);
  assert.equal(cut.count, cut.items.length);
  assert.ok(cut.count > 1 && cut.count < 500);
  assert.equal(cut.items[0]?.line, 'step 0');
  assert.ok(JSON.stringify(cut, null, 2).length <= 5_000);
  // The cut is maximal: one more line would not fit.
  const oneMore = {
    items: items.slice(0, cut.count + 1),
    count: cut.count + 1,
    truncated: true,
  };
  assert.ok(JSON.stringify(oneMore, null, 2).length > 5_000);

  const whole = fitSnapshot(items.slice(0, 3), false, 5_000);
  assert.equal(whole.truncated, false);
  assert.equal(whole.count, 3);
});

// System log lines carry whole-second timestamps and the API resumes only by
// timestamp, so a cut inside a run of equal timestamps could not be resumed
// without skipping or looping. The cut moves back to the run's start.
test('a cut never splits lines that share a timestamp', async () => {
  const { fitSnapshot } = await import('#src/specgen/clients/sse');
  const items = Array.from({ length: 300 }, (_, i) => ({
    source: 'system',
    line: `layer ${i} Extracting`,
    ts: `2026-11-05T23:56:${String(Math.floor(i / 40)).padStart(2, '0')}Z`,
  }));
  const cut = fitSnapshot(items, false, 5_000);
  assert.equal(cut.truncated, true);
  assert.ok(cut.count > 0 && cut.count % 40 === 0, `count ${cut.count}`);
  assert.notEqual(items[cut.count]?.ts, cut.items.at(-1)?.ts);

  // One run larger than the cap cannot move back; it keeps what fits.
  const oneRun = items.map((item) => ({ ...item, ts: '2026-11-05T23:56:55Z' }));
  const forced = fitSnapshot(oneRun, false, 5_000);
  assert.ok(forced.count > 0);
  assert.ok(JSON.stringify(forced, null, 2).length <= 5_000);
});

test('an oversized line is clipped so the snapshot still fits', async () => {
  const { fitSnapshot, LOG_SNAPSHOT_MAX_CHARS } = await import(
    '#src/specgen/clients/sse'
  );
  for (const items of [
    [{ line: 'x'.repeat(60_000), ts: 't0' }],
    [
      { line: 'x'.repeat(60_000), ts: 't0' },
      { line: 'next', ts: 't1' },
    ],
  ]) {
    const snapshot = fitSnapshot(items, false);
    assert.equal(snapshot.truncated, true);
    assert.ok(snapshot.count >= 1);
    assert.equal(snapshot.items[0]?.ts, 't0');
    assert.match(String(snapshot.items[0]?.line), /\[clipped 44000 chars\]$/);
    assert.ok(
      JSON.stringify(snapshot, null, 2).length <= LOG_SNAPSHOT_MAX_CHARS
    );
  }
});

test('headers slower than the connect budget fail even with read time left', async () => {
  const { runTool } = await import('#src/specgen/tools/util');
  const reader = createSseReader({
    apiKey: 'test-key',
    connectTimeoutMs: 20,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const signal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true }
        );
      });
      return new Response(frame('too late'));
    }) as typeof fetch,
  });
  const started = Date.now();
  const result = await runTool(async () => ({
    ok: true,
    status: 200,
    payload: await collectLogSnapshot(reader, 'https://x/logs', {
      maxWaitMs: 1_000,
    }),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 504);
  assert.ok(Date.now() - started < 150, `took ${Date.now() - started} ms`);
});

test('the read window is not shortened by slow headers', async () => {
  const reader = createSseReader({
    apiKey: 'test-key',
    connectTimeoutMs: 200,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return new Response(
        new ReadableStream({
          start(controller) {
            // 80 ms into the read window, 230 ms after the request: inside
            // the window only because it starts at the headers. Measured
            // from the request (the old behavior), it would close at 100 ms.
            setTimeout(
              () => controller.enqueue(new TextEncoder().encode(frame('late'))),
              80
            );
          },
        })
      );
    },
  });
  const result = await collectLogSnapshot(reader, 'https://x/logs', {
    maxWaitMs: 100,
  });
  assert.deepEqual(
    result.items.map((item) => item.line),
    ['late']
  );
});

// JSON escaping grows text: each ESC byte serializes as \u001b, six
// characters. A character cap alone let ANSI-colored output past the
// serialized ceiling.
test('escape-heavy and oversized-metadata entries still fit the cap', async () => {
  const { fitSnapshot, LOG_SNAPSHOT_MAX_CHARS } = await import(
    '#src/specgen/clients/sse'
  );
  const ansi = '\x1b[31mX\x1b[0m'.repeat(2_000);
  const bigMeta = { line: 'ok', ts: 't0', source: 's'.repeat(40_000) };
  for (const items of [
    [{ line: ansi, ts: 't0' }],
    [
      { line: ansi, ts: 't0' },
      { line: 'next', ts: 't1' },
    ],
    [bigMeta],
    [bigMeta, { line: 'next', ts: 't1' }],
  ]) {
    const snapshot = fitSnapshot(items, false);
    assert.equal(snapshot.truncated, true);
    assert.ok(snapshot.count >= 1);
    assert.equal(snapshot.items[0]?.ts, 't0');
    const size = JSON.stringify(snapshot, null, 2).length;
    assert.ok(size <= LOG_SNAPSHOT_MAX_CHARS, `${size} chars`);
  }
});

test('a body that fails after headers is an error, not a partial snapshot', async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frame('first')));
      setTimeout(() => controller.error(new Error('connection reset')), 10);
    },
  });
  const reader = createSseReader({
    apiKey: 'test-key',
    fetchImpl: async () => new Response(source),
  });
  await assert.rejects(
    collectLogSnapshot(reader, 'https://x/logs', { maxWaitMs: 1_000 }),
    /connection reset/
  );
  assert.equal(source.locked, false);
});
