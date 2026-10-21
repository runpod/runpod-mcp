import { it, expect, vi } from 'vitest';
import { getRateLimitInfo, createRetryFetch, parseRetryAfter } from '../src/index.js';
it('uses the longest exhausted window or Retry-After, with quoted delimiters', () => {
  const info = getRateLimitInfo(new Headers({ RateLimit: '"minute";r=0;t=10, "gpu,hour";t=3600;r=0;pk="a;b", day;r=10;t=86400', 'Retry-After': '20' }));
  expect(info.retryDelayMs).toBe(3600000); expect(info.incomplete).toBe(false);
  expect(info.windows[1].name).toBe('gpu,hour');
});
it.each(['broken header', '"hour";r=0', '"hour";r=0;t=-1', '"hour";r=0;t=1.5', '"hour";r="0";t=10'])(
  'marks incomplete rate-limit metadata: %s', header => {
    expect(getRateLimitInfo(new Headers({ RateLimit: header })).incomplete).toBe(true);
  });
it('does not turn malformed Retry-After numbers into dates', () => {
  for (const raw of ['1.5', '-1', '1e3', '9'.repeat(100)]) expect(parseRetryAfter(raw)).toBeUndefined();
});
it('returns long or unknown limits instead of retrying early', async () => {
  for (const headers of [{ RateLimit: '"hour";r=0;t=3600' }, { 'Retry-After': '3600' }, { RateLimit: '"hour";r=0' }] as Record<string, string>[]) {
    const response = new Response('{}', { status: 429, headers });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response); const sleep = vi.fn(async () => {});
    expect(await createRetryFetch({ fetch, sleep })('https://example.test')).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
    await response.body?.cancel();
  }
});
it('honors a usable RateLimit-only reset', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 429, headers: { RateLimit: 'hour;r=0;t=2' } })).mockResolvedValueOnce(new Response(null, { status: 204 }));
  const sleep = vi.fn(async () => {});
  await createRetryFetch({ fetch, sleep })('https://example.test');
  expect(sleep).toHaveBeenCalledWith(2000);
});
