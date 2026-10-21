import { it, expect } from 'vitest';
import { iterateLogEvents } from '../src/index.js';
const encode = (s: string) => new TextEncoder().encode(s);
function stream(raw: string, size = 1) {
  const bytes = encode(raw);
  return new ReadableStream<Uint8Array>({ start(c) {
    for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
    c.close();
  } });
}
async function collect(raw: string, size = 1) {
  const result = [];
  for await (const e of iterateLogEvents(stream(raw, size))) result.push(e);
  return result;
}
it('handles split UTF-8, CR/LF/CRLF, comments, multiline data, IDs and event types', async () => {
  const raw = '\ufeff: heartbeat\r\nid: 4\r\nevent: log\r\ndata: {"line":\r\ndata: "hé😀"}\r\n\r\ndata: next\r\rdata: last\n\n';
  for (const size of [1, 2, 9, 1000]) expect(await collect(raw, size)).toEqual([
    { event: 'log', id: '4', data: { line: 'hé😀' } },
    { event: 'message', id: '4', data: { raw: 'next' } },
    { event: 'message', id: '4', data: { raw: 'last' } },
  ]);
});
it('preserves non-object or invalid typed data and discards incomplete frames', async () => {
  const events = await collect('data: null\n\ndata: {"line":4}\n\ndata:\n\ndata: unfinished');
  expect(events.map(e => e.data)).toEqual([{ raw: 'null' }, { raw: '{"line":4}' }, { raw: '' }]);
});
it('bounds event buffering', async () => {
  const next = iterateLogEvents(stream('data: ' + 'x'.repeat(100)), { maxEventBytes: 16 });
  await expect(next.next()).rejects.toThrow('maxEventBytes');
});
it('cancels and unlocks on consumer break', async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encode('data: first\n\ndata: second\n\n')); }, cancel() { cancelled = true; } });
  for await (const event of iterateLogEvents(source)) { expect(event.data.raw).toBe('first'); break; }
  expect(cancelled).toBe(true); expect(source.locked).toBe(false);
});
it('caller abort interrupts a stalled read', async () => {
  const controller = new AbortController(); const source = new ReadableStream<Uint8Array>();
  const iterator = iterateLogEvents(source, { signal: controller.signal });
  const pending = iterator.next(); const reason = new Error('stop'); controller.abort(reason);
  await expect(pending).rejects.toBe(reason); expect(source.locked).toBe(false);
});

it('resets IDs, ignores null IDs, and preserves additional JSON fields', async () => {
  const events = await collect('id: first\ndata: {}\n\nid:\nevent:\ndata: {"extra":42}\n\nid: bad\0id\ndata: last\n\n');
  expect(events).toEqual([
    { event: 'message', id: 'first', data: {} },
    { event: 'message', id: '', data: { extra: 42 } },
    { event: 'message', id: '', data: { raw: 'last' } },
  ]);
});
it('propagates source errors and releases the reader', async () => {
  const reason = new Error('connection lost');
  const source = new ReadableStream<Uint8Array>({ start(controller) { controller.error(reason); } });
  await expect(iterateLogEvents(source).next()).rejects.toBe(reason);
  expect(source.locked).toBe(false);
});
