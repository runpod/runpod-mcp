import { describe, it, expect, vi } from 'vitest';
import { createRunpodClient, createDeadlineFetch } from '../src/index.js';

describe('whole-operation deadlines', () => {
  it('bounds a fetch implementation that ignores cancellation', async () => {
    const client = createRunpodClient({ apiKey: 'test', timeoutMs: 15, fetch: () => new Promise(() => {}) });
    await expect(client.GET('/v2/catalog/gpus')).rejects.toMatchObject({ name: 'TimeoutError' });
  });
  it('bounds a body that stalls after headers, even if it ignores cancellation', async () => {
    let cancelled = false;
    const client = createRunpodClient({ apiKey: 'test', timeoutMs: 15, fetch: async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
    })) });
    await expect(client.GET('/v2/catalog/gpus')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(cancelled).toBe(true);
  });
  it('puts retries and custom sleeps under one deadline', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 503 }));
    const client = createRunpodClient({ apiKey: 'test', timeoutMs: 15, fetch, retry: { sleep: () => new Promise(() => {}) } });
    await expect(client.GET('/v2/catalog/gpus')).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves caller abort reasons and never sends pre-aborted requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const controller = new AbortController(); const reason = new Error('caller'); controller.abort(reason);
    const client = createRunpodClient({ apiKey: 'test', fetch });
    await expect(client.GET('/v2/catalog/gpus', { signal: controller.signal })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels a returned stream promptly and preserves response metadata', async () => {
    const controller = new AbortController();
    const original = new Response(new ReadableStream());
    Object.defineProperty(original, 'url', { value: 'https://example.test/final' });
    const response = await createDeadlineFetch(async () => original, 1000)('https://example.test', { signal: controller.signal });
    expect(response.url).toBe(original.url);
    const pending = response.text(); const reason = new Error('stop'); controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
  it('clears deadlines for consumed, empty and cancelled bodies', async () => {
    vi.useFakeTimers();
    try {
      for (const original of [new Response('ok'), new Response(null, { status: 204 }), new Response(new ReadableStream())]) {
        const response = await createDeadlineFetch(async () => original, 1000)('https://example.test');
        if (original.status === 204) expect(response.body).toBeNull();
        else if (original.headers.has('content-type')) await response.text();
        else await response.body!.cancel();
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  });
  it.each([0, -1, NaN, Infinity, 2147483648])('rejects invalid timeout %s', timeoutMs => {
    expect(() => createRunpodClient({ apiKey: 'test', timeoutMs })).toThrow(RangeError);
  });
});
