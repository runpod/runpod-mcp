import { abortable } from "./abort.js";

/** Keep the deadline active until the body is consumed, cancelled, or fails. */
function wrapResponse(response: Response, signal: AbortSignal, cleanup: () => void): Response {
  const reader = response.body!.getReader();
  let finished = false;
  let bodyController: ReadableStreamDefaultController<Uint8Array>;

  function finish() {
    finished = true;
    signal.removeEventListener("abort", onAbort);
    cleanup();
  }

  function cancelReader(reason?: unknown) {
    // A custom source's cancel() can hang; cleanup must not wait for it.
    void reader.cancel(reason).catch(() => {});
    reader.releaseLock();
  }

  function onAbort() {
    if (finished) return;
    finish();
    bodyController.error(signal.reason);
    cancelReader(signal.reason);
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (finished) return;
        if (!chunk.done) {
          controller.enqueue(chunk.value);
          return;
        }
        finish();
        reader.releaseLock();
        controller.close();
      } catch (error) {
        if (finished) return;
        finish();
        reader.releaseLock();
        controller.error(error);
      }
    },
    cancel(reason) {
      finish();
      cancelReader(reason);
    },
  });
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const key of ["url", "redirected", "type"] as const) {
    Object.defineProperty(wrapped, key, { value: response[key] });
  }
  return wrapped;
}

/** One deadline across fetch, retries, backoff and response-body consumption. */
export function createDeadlineFetch(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be positive and at most 2147483647");
  }

  return async (input, init) => {
    const original = new Request(input, init);
    original.signal.throwIfAborted();
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(original.signal.reason);
    const timer = setTimeout(() => {
      controller.abort(new DOMException(`Runpod request exceeded ${timeoutMs}ms`, "TimeoutError"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      original.signal.removeEventListener("abort", onCallerAbort);
    };
    original.signal.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const operation = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const response = await fetchImpl(new Request(original, { signal: controller.signal }));
        // Dispose of a response that arrives after a non-cooperative fetch timed out.
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        controller.signal.throwIfAborted();
        return response;
      });
      const response = await abortable(operation, controller.signal);
      if (response.body) return wrapResponse(response, controller.signal, cleanup);
      cleanup();
      return response;
    } catch (error) {
      cleanup();
      throw error;
    }
  };
}
