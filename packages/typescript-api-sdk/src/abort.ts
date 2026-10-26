/** Stop waiting even when an injected operation does not honor cancellation. */
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    // Always observe the operation, including rejection after cancellation.
    operation.then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
}
