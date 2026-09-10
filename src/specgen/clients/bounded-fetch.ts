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
    // Match Request's signal precedence, preserving deadlines supplied by callers.
    const incoming =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const cleanup = () => {
      clearTimeout(timer);
      incoming?.removeEventListener('abort', abort);
    };
    const abort = () => {
      controller.abort(incoming?.reason);
      cleanup();
    };
    if (incoming?.aborted) abort();
    else incoming?.addEventListener('abort', abort, { once: true });
    let response: Response;
    try {
      response = await fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
    if (!response.body) {
      // 204 / HEAD: no body to stall on.
      cleanup();
      return response;
    }
    const reader = response.body.getReader();
    const bounded = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            cleanup();
            stream.close();
          } else stream.enqueue(value);
        } catch (error) {
          cleanup();
          stream.error(error);
        }
      },
      async cancel(reason) {
        cleanup();
        await reader.cancel(reason);
      },
    });
    return new Response(bounded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
