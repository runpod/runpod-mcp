import { describe, expect, it, vi } from "vitest";
import { createRetryFetch, parseRetryAfter, type RetryOptions } from "../src/retry.js";

function fastRetry(base: typeof fetch) {
  return createRetryFetch({
    fetch: base,
    minBackoffMs: 1,
    maxBackoffMs: 4,
    random: () => 0,
    sleep: () => Promise.resolve(),
  });
}

function countingFetch(handler: (calls: number, request: Request) => Response | Promise<Response>) {
  let calls = 0;
  const impl: typeof fetch = async (input, init) => handler(++calls, new Request(input, init));
  return { impl, calls: () => calls };
}

/** Retry wrapper that records every backoff it waits for instead of sleeping. */
function recordingRetry(base: typeof fetch, options: RetryOptions = {}) {
  const delays: number[] = [];
  const impl = createRetryFetch({
    fetch: base,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    ...options,
  });
  return { impl, delays };
}

describe("createRetryFetch", () => {
  it("retries GET on 503 until success", async () => {
    const server = countingFetch((n) =>
      n < 3 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 }),
    );
    const response = await fastRetry(server.impl)("https://example.test/v2/pods");
    expect(response.status).toBe(200);
    expect(server.calls()).toBe(3);
  });

  it("gives up after maxAttempts and returns the last response", async () => {
    const server = countingFetch(() => new Response("bad", { status: 502 }));
    const response = await fastRetry(server.impl)("https://example.test/v2/pods");
    expect(response.status).toBe(502);
    expect(server.calls()).toBe(4);
  });

  it("does not replay POST on 500", async () => {
    const server = countingFetch(() => new Response("boom", { status: 500 }));
    const response = await fastRetry(server.impl)("https://example.test/v2/pods", {
      method: "POST",
      body: JSON.stringify({ name: "pod" }),
    });
    expect(response.status).toBe(500);
    expect(server.calls()).toBe(1);
  });

  it("retries POST on 429 with the body replayed", async () => {
    let lastBody = "";
    const server = countingFetch(async (n, request) => {
      lastBody = await request.text();
      return n === 1
        ? new Response("slow down", { status: 429, headers: { "Retry-After": "0" } })
        : new Response("created", { status: 201 });
    });
    const response = await fastRetry(server.impl)("https://example.test/v2/pods", {
      method: "POST",
      body: JSON.stringify({ name: "pod" }),
    });
    expect(response.status).toBe(201);
    expect(server.calls()).toBe(2);
    expect(lastBody).toBe(JSON.stringify({ name: "pod" }));
  });

  it("retries network errors for idempotent methods only", async () => {
    const get = countingFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fastRetry(get.impl)("https://example.test/v2/pods")).rejects.toThrow(
      "fetch failed",
    );
    expect(get.calls()).toBe(4);

    const post = countingFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      fastRetry(post.impl)("https://example.test/v2/pods", { method: "POST" }),
    ).rejects.toThrow("fetch failed");
    expect(post.calls()).toBe(1);
  });

  it("re-throws an abort instead of retrying it", async () => {
    // The three shapes a caller can hit: AbortController.abort(),
    // AbortSignal.timeout(), and a fetch polyfill's plain Error.
    const aborts = [
      new DOMException("The operation was aborted", "AbortError"),
      new DOMException("The operation timed out", "TimeoutError"),
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    ];
    for (const abort of aborts) {
      const server = countingFetch(() => {
        throw abort;
      });
      await expect(fastRetry(server.impl)("https://example.test/v2/pods")).rejects.toBe(abort);
      expect(server.calls(), abort.name).toBe(1);
    }
  });

  it("returns the response when Retry-After exceeds the wait ceiling", async () => {
    const server = countingFetch((n) =>
      n === 1
        ? new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } })
        : new Response("ok", { status: 200 }),
    );
    const { impl, delays } = recordingRetry(server.impl, { maxRetryAfterMs: 250 });
    const response = await impl("https://example.test/v2/pods");
    expect(response.status).toBe(429);
    expect(delays).toEqual([]);
    expect(server.calls()).toBe(1);
    await response.body?.cancel();
  });

  it("backs off exponentially up to maxBackoffMs, with equal jitter", async () => {
    const busy = () => new Response("busy", { status: 503 });
    // random() === 0 takes the bottom of each jitter window, === 1 the top;
    // the window is [backoff/2, backoff] and backoff caps at maxBackoffMs.
    const low = recordingRetry(countingFetch(busy).impl, {
      minBackoffMs: 1_000,
      maxBackoffMs: 3_000,
      random: () => 0,
    });
    await low.impl("https://example.test/v2/pods");
    expect(low.delays).toEqual([500, 1_000, 1_500]);

    const high = recordingRetry(countingFetch(busy).impl, {
      minBackoffMs: 1_000,
      maxBackoffMs: 3_000,
      random: () => 1,
    });
    await high.impl("https://example.test/v2/pods");
    expect(high.delays).toEqual([1_000, 2_000, 3_000]);
  });

  it("releases the body of a response it is about to discard", async () => {
    const discarded: Response[] = [];
    const server = countingFetch((n) => {
      const response =
        n === 1 ? new Response("busy", { status: 503 }) : new Response("ok", { status: 200 });
      if (n === 1) discarded.push(response);
      return response;
    });
    await fastRetry(server.impl)("https://example.test/v2/pods");
    expect(discarded[0]?.bodyUsed).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  it("parses delay-seconds", () => {
    expect(parseRetryAfter("7")).toBe(7_000);
  });
  it("parses an HTTP-date", () => {
    const future = new Date(Date.now() + 90_000).toUTCString();
    const parsed = parseRetryAfter(future)!;
    expect(parsed).toBeGreaterThan(85_000);
    expect(parsed).toBeLessThanOrEqual(90_000);
  });
  it("clamps past dates to zero", () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
  });
  it("rejects garbage", () => {
    expect(parseRetryAfter("garbage")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

it.each([
  { maxAttempts: 0 }, { maxAttempts: -1 }, { maxAttempts: NaN },
  { maxAttempts: Infinity }, { maxAttempts: 1.5 },
  { minBackoffMs: -1 }, { maxBackoffMs: NaN }, { maxRetryAfterMs: Infinity },
  { maxRetryAfterMs: 2_147_483_648 }, { minBackoffMs: 2000, maxBackoffMs: 1000 },
])("rejects invalid retry settings: %j", (options) => {
  expect(() => createRetryFetch(options)).toThrow(RangeError);
});

it.each([new Error("cancelled by caller"), "custom cancellation"])("preserves an already-aborted reason: %s", async (reason) => {
  const base = vi.fn<typeof fetch>();
  const controller = new AbortController();
  controller.abort(reason);
  await expect(createRetryFetch({ fetch: base })("https://example.test", { signal: controller.signal })).rejects.toBe(reason);
  expect(base).not.toHaveBeenCalled();
});

it("interrupts backoff immediately and clears the retry timer", async () => {
  vi.useFakeTimers();
  try {
    const base = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    const controller = new AbortController();
    const reason = new Error("deadline");
    const pending = createRetryFetch({ fetch: base })("https://example.test", { signal: controller.signal });
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort(reason);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(base).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("stops waiting for an injected sleep on abort", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  const base = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 429 }));
  const pending = createRetryFetch({ fetch: base, sleep: () => {
    controller.abort(reason);
    return new Promise(() => {});
  } })("https://example.test", { signal: controller.signal });
  await expect(pending).rejects.toBe(reason);
  expect(base).toHaveBeenCalledTimes(1);
});

it("does not retry a network rejection after a custom abort", async () => {
  const controller = new AbortController();
  const reason = new Error("custom");
  const base = vi.fn<typeof fetch>().mockImplementation(async () => {
    controller.abort(reason);
    throw new TypeError("fetch rejected");
  });
  await expect(createRetryFetch({ fetch: base })("https://example.test", { signal: controller.signal })).rejects.toBe(reason);
  expect(base).toHaveBeenCalledTimes(1);
});
