# Client guide

```ts
import { createRunpodClient } from "@runpod/typescript-api-sdk";

const client = createRunpodClient(); // RUNPOD_API_KEY from the environment
const { data, error, response } = await client.GET("/v2/catalog/gpus", {
  signal: AbortSignal.timeout(15_000),
});
if (!response.ok) {
  throw new Error(`Catalog failed (${response.status}): ${JSON.stringify(error)}`);
}
if (!data) throw new Error("Catalog response had no data");
console.log(`${data.gpus.length} GPU types`);
```

CommonJS uses `const { createRunpodClient } = require("@runpod/typescript-api-sdk")`.

Always use `response.ok` to decide whether an HTTP response succeeded. A
bodyless failure can return `error: undefined`; neither `if (error)` nor
`error !== undefined` reliably checks HTTP status. `response.ok` does not narrow
TypeScript's response union, so check `data` before accessing it. Some successful
operations intentionally return no body.

HTTP failures with decodable bodies return the usual openapi-fetch result.
Network errors, cancellation, and response parsing errors can reject the promise.
Types describe the vendored contract; they do not validate response data at runtime.
OpenAPI constraints such as conditional `if`/`then`, patterns, and numeric limits
are not all expressible in generated TypeScript. For example, pod creation requires
an image unless a template is supplied, and exactly one of GPU or CPU; the API
validates these rules.

Options: `apiKey` overrides `RUNPOD_API_KEY`; `baseUrl` overrides
`RUNPOD_API_BASE_URL`, then defaults to `https://api.runpod.io`. Blank base URLs
count as unset. `retry` configures or disables retries; `fetch` injects the base
implementation. Catalog query arrays use the spec's comma-separated encoding.
Per-request openapi-fetch options, including `signal` and `parseAs`, remain available.

## Retries and timeouts

Defaults: four total attempts, exponential backoff with equal jitter from a
1-second base to a 30-second maximum. The maximum automatic server-directed
wait is 60 seconds (`maxRetryAfterMs`). Longer waits return the HTTP response
without retrying; they are never shortened into premature retries.
`getRateLimitInfo(response.headers)` exposes quota windows, the longest known
wait, and whether the metadata is incomplete. Both `Retry-After` and exhausted
`RateLimit` windows are considered. Incomplete metadata prevents automatic retries.
429 responses retry for all methods. Network failures and 500/502/503/504 retry
only for GET, HEAD, PUT, DELETE, and OPTIONS. POST and PATCH do not retry those
failures, because the mutation may already have happened.

Pass `retry: { maxAttempts, minBackoffMs, maxBackoffMs, maxRetryAfterMs }`, or
`retry: false`. Attempts must be a positive safe integer. Delays must be finite,
nonnegative, at most 2,147,483,647 milliseconds, and minimum backoff must not
exceed maximum backoff.

The default whole-operation deadline is **30 seconds**. Configure it with
`createRunpodClient({ timeoutMs: 15_000 })`, or use `timeoutMs: false` to disable
the SDK timer. A caller-provided `signal` can cancel earlier. The same budget
covers all retry attempts, sleeps, headers, and response-body consumption.
Cancellation preserves the caller's reason; the SDK deadline raises `TimeoutError`.
Even an injected fetch/body that ignores cancellation cannot keep the caller
waiting past the deadline, though underlying custom work may continue.

For a long-lived log stream, choose a suitable deadline or disable the SDK timer
and supply your own abort signal. Always consume or cancel returned streams so
resources are released.

## Logs and runnable examples

After `pnpm build`, these examples make read-only requests:

```bash
node --env-file=.env examples/catalog.mjs
node --env-file=.env examples/pod-logs.mjs YOUR_POD_ID
```

The `--env-file` flag requires Node 20.6 or newer; on earlier Node 20 versions,
export the variables in your shell. The SDK itself does not load `.env` files.

Pod and worker log endpoints return Server-Sent Events (SSE). Request
`parseAs: "stream"`, then pass the response body to `iterateLogEvents`.
The [logging guide](logging.md) has a complete example and describes the event
format, cancellation, and limits. The runnable pod-log example prints decoded
log lines and stops after 30 seconds.

The SDK does not print diagnostic logs or configure a logging framework. Your
application decides where to send the events returned by the iterator.
