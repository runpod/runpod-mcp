// The one request-deadline wrapper. An explicit controller + ref'd timer
// rather than AbortSignal.timeout, whose unref'd timer does not keep the
// event loop alive — on an otherwise-idle loop that deadline never fires and
// the request hangs anyway. Used by the SDK fetch (context.ts) and the
// GraphQL/runtime clients; the SSE reader keeps its own controller because it
// also aborts on the byte cap, not just the clock.
export function boundedFetch(
  fetchImpl: typeof fetch,
  timeoutMs: number
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(
            `Runpod API request exceeded ${timeoutMs}ms`,
            'TimeoutError'
          )
        ),
      timeoutMs
    );
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}
