# Reading logs

`iterateLogEvents` reads pod or worker logs returned by Runpod as Server-Sent
Events (SSE). It is a handwritten SDK helper layered over the generated API
client. It does not collect application diagnostics or install a logger.

## Start with a pod

Set `RUNPOD_API_KEY` in your server's environment, then run:

```ts
import { createRunpodClient, iterateLogEvents } from "@runpod/typescript-api-sdk";

const client = createRunpodClient({ timeoutMs: 60_000 });
const { data, response } = await client.GET("/v2/pods/{id}/logs", {
  params: { path: { id: "YOUR_POD_ID" }, query: { tail: 100 } },
  parseAs: "stream",
});
if (!response.ok) throw new Error(`Logs failed: HTTP ${response.status}`);
if (!data) throw new Error("Log response had no body");

try {
  for await (const event of iterateLogEvents(data)) {
    console.log(event.data.line ?? event.data.raw ?? JSON.stringify(event.data));
  }
} catch (error) {
  if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
  console.error("Log request reached its 60-second deadline.");
}
```

The deadline starts with the request, not the first log event. The default is
30 seconds. HTTP failures are checked with `response.ok`; network failures and
stream errors throw. This example treats reaching the deadline while reading
as an expected stop; a timeout before receiving the response still throws.

From a source checkout, run `pnpm build` and then
`node --env-file=.env examples/pod-logs.mjs YOUR_POD_ID` for a 30-second example.

## What an event contains

For this SSE frame:

```text
id: 42
event: log
data: {"source":"stdout","line":"Worker ready","ts":"2026-01-01T00:00:00Z"}

```

The iterator yields:

```ts
{
  event: "log",
  id: "42",
  data: { source: "stdout", line: "Worker ready", ts: "2026-01-01T00:00:00Z" }
}
```

- `event` defaults to `"message"` when absent or empty.
- `id` is optional and carries forward until replaced. An empty `id:` resets it
  to `""`; IDs containing a null character are ignored.
- `data` preserves JSON objects and additional fields. Known fields `source`,
  `line`, `ts`, and `raw` must be strings when present. They are all optional;
  `ts` is preserved as a string, not converted to a `Date`.
- Plain text, invalid JSON, arrays, scalar JSON, and objects with invalid known
  fields become `{ raw: originalData }`.

Multiple `data:` lines are joined with newlines before JSON parsing. UTF-8 and
frames can span network chunks. LF, CR, and CRLF line endings are supported.
Comments and unknown SSE fields are ignored. An event requires a blank line
terminator; an incomplete final event is discarded.

## Cancellation and limits

For a stream without an SDK deadline, use `createRunpodClient({ timeoutMs: false })`
and pass your own `AbortController.signal` to both the request and
`iterateLogEvents(data, { signal: controller.signal })`. Call `controller.abort()`
when the application is done. Cancellation throws the signal's reason.

Breaking out of the loop cancels the stream and releases its reader. The iterator
owns that reader: do not read the same stream elsewhere at the same time. If you
request a stream but never iterate it, cancel the body yourself with
`await data.cancel()`.

`maxEventBytes` defaults to **1,048,576 (1 MiB)** and must be a positive safe integer.
It bounds the UTF-8 framing content accumulated for one event, including comments
and field names; CRLF counts as one line ending. Exceeding it throws `RangeError`
and cancels the stream. This is a per-event limit, not a total stream-size limit.

There is no automatic reconnection, replay, deduplication, filtering, or total
line limit. Request retries apply before a response is returned; a failed log
stream is not restarted. Your application chooses how to store or display events.
