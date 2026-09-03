// The one request-deadline wrapper. An explicit controller + ref'd timer
// rather than AbortSignal.timeout, whose unref'd timer does not keep the
// event loop alive — on an otherwise-idle loop that deadline never fires and
// the request hangs anyway. Used by the SDK fetch (context.ts) and the
// GraphQL/runtime clients; the SSE reader keeps its own controller because it
// also aborts on the byte cap, not just the clock.
//
// The deadline covers the WHOLE transaction, not just the headers: fetch
// resolves when headers arrive, but a backend can send headers and then stall
// mid-body (api/index.ts documents the same failure mode on the OAuth path).
// Clearing the timer at that point would leave the subsequent .text()/.json()
// read unbounded — so the timer stays armed until the body stream completes,
// and the returned Response carries a pass-through of the body that clears it
// on close. Aborting mid-body errors the stream, which the callers' body
// reads surface as the TimeoutError runTool maps to a retryable 504.
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
    let response: Response;
    try {
      response = await fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    if (!response.body) {
      // 204 / HEAD: no body to stall on.
      clearTimeout(timer);
      return response;
    }
    const bounded = response.body.pipeThrough(
      new TransformStream({
        flush() {
          clearTimeout(timer);
        },
      })
    );
    return new Response(bounded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
