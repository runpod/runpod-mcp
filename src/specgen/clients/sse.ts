import { iterateLogEvents, type LogEntry } from '@runpod/typescript-api-sdk';
export type { LogEntry } from '@runpod/typescript-api-sdk';

// Bounded SSE reader for the v2 log endpoints (GET /v2/pods/{id}/logs and
// GET /v2/serverless/{id}/workers/{workerId}/logs). Both serve
// text/event-stream and hold the connection open to tail live output, so the
// generated JSON dispatch cannot consume them; the curated log tools read a
// time- and byte-bounded snapshot instead. Ported from the official MCP
// server's reader (Apache-2.0, runpod/runpod-mcp).

import { withRateLimitHint } from '../../_shared/rate-limit.js';
import { HttpError, missingKeyError } from './http-error.js';
import { boundedFetch } from './bounded-fetch.js';

export const LOG_STREAM_DEFAULT_WAIT_MS = 5_000;
export const LOG_STREAM_MAX_BYTES = 256 * 1024;
// Time allowed for the response headers, on top of the read window. Headers
// commonly take 2-3 s; when one deadline covered both, a maxWaitMs of 2000
// failed as "did not respond" instead of returning a snapshot.
export const LOG_STREAM_CONNECT_TIMEOUT_MS = 10_000;
// Ceiling on the snapshot as the server serializes it (pretty-printed JSON).
// MCP clients cap tool output — Claude Code at 25,000 tokens by default, which
// a 56,178-character log snapshot exceeded — and an over-cap result is lost
// to the agent, so the snapshot is cut to fit with `truncated: true` instead.
export const LOG_SNAPSHOT_MAX_CHARS = 32_000;

export type SseReader = (
  url: string,
  opts: { maxWaitMs: number; maxBytes: number }
) => Promise<{ raw: string; truncated: boolean }>;

// Headers get connectTimeoutMs; once they arrive, the stream is read for
// maxWaitMs (it stays open to tail live output) or until maxBytes, whichever
// comes first, and what was collected is returned. A timeout before headers
// is a failed request. The fetch deadline (connect + read) stays as a
// backstop, and ends an established stream normally. Bytes are concatenated
// and decoded once at the end so a UTF-8 char split across chunks is never
// corrupted.
export function createSseReader(
  options: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    connectTimeoutMs?: number;
  } = {}
): SseReader {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? LOG_STREAM_CONNECT_TIMEOUT_MS;

  return async (url, opts) => {
    if (!apiKey) throw missingKeyError();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    let streamEstablished = false;
    // Bounds the wait for headers alone; cleared once they arrive, so it
    // never cuts the read window.
    const connect = new AbortController();
    const connectTimer = setTimeout(
      () =>
        connect.abort(
          new DOMException(
            `Runpod log stream sent no headers within ${connectTimeoutMs}ms`,
            'TimeoutError'
          )
        ),
      connectTimeoutMs
    );
    try {
      const response = await boundedFetch(
        fetchImpl,
        connectTimeoutMs + opts.maxWaitMs
      )(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        signal: connect.signal,
      }).finally(() => clearTimeout(connectTimer));
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new HttpError(
          `Runpod API error (${response.status})`,
          response.status,
          response.status === 429
            ? withRateLimitHint({ error: body }, response.headers)
            : body
        );
      }
      streamEstablished = true;
      if (response.body) {
        // The read window starts now, not at the request, so slow headers do
        // not eat into it.
        const reader = response.body.getReader();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const windowClosed = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), opts.maxWaitMs);
        });
        try {
          for (;;) {
            const read = reader.read();
            // Still pending when the window closes; cancel() below settles it.
            read.catch(() => {});
            const next = await Promise.race([read, windowClosed]);
            if (next === null || next.done) break;
            const boundedChunk = next.value.subarray(0, opts.maxBytes - bytes);
            chunks.push(boundedChunk);
            bytes += boundedChunk.length;
            if (bytes >= opts.maxBytes) {
              truncated = true;
              break;
            }
          }
        } finally {
          clearTimeout(timer);
          // A source's cancel() can hang; do not wait for it.
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    } catch (err) {
      // The request deadline ends an established stream normally.
      // Before headers, there is no successful log read to return; runTool
      // maps the timeout to a retryable 504 instead of an empty success.
      if (
        !(
          streamEstablished &&
          err instanceof Error &&
          err.name === 'TimeoutError'
        )
      ) {
        throw err;
      }
    }
    return { raw: Buffer.concat(chunks).toString('utf8'), truncated };
  };
}

export interface LogSnapshotParams {
  source?: 'container' | 'system' | 'both';
  tail?: number;
  since?: string;
  maxWaitMs?: number;
}

// Read a bounded snapshot of a log endpoint and return the parsed frames.
// `source: 'both'` (or omitted) sends no source param — the endpoint returns
// both streams when it is absent (the wire enum is only container|system).
export async function collectLogSnapshot(
  reader: SseReader,
  logsUrl: string,
  params: LogSnapshotParams
): Promise<LogSnapshot> {
  const qs = new URLSearchParams();
  if (params.source && params.source !== 'both')
    qs.append('source', params.source);
  if (params.tail !== undefined) qs.append('tail', String(params.tail));
  if (params.since) qs.append('since', params.since);
  const query = qs.toString() ? `?${qs}` : '';
  const { raw, truncated } = await reader(`${logsUrl}${query}`, {
    maxWaitMs: params.maxWaitMs ?? LOG_STREAM_DEFAULT_WAIT_MS,
    maxBytes: LOG_STREAM_MAX_BYTES,
  });
  // The SDK handles SSE framing and discards an incomplete final event.
  // MCP keeps ownership of its time and total-byte snapshot limits above.
  const items: LogEntry[] = [];
  for await (const event of iterateLogEvents(new Response(raw).body!)) {
    items.push(event.data);
  }
  return fitSnapshot(items, truncated);
}

type LogSnapshot = { items: LogEntry[]; count: number; truncated: boolean };

const serializedLength = (snapshot: LogSnapshot) =>
  JSON.stringify(snapshot, null, 2).length;

// A single entry is clipped to this many characters of text, so no one entry
// takes most of a snapshot.
export const LOG_ENTRY_MAX_CHARS = 16_000;

const CLIPPABLE_KEYS = ['line', 'raw'] as const;

function clipText(text: string, keep: number): string {
  // Never split a surrogate pair.
  const code = text.charCodeAt(keep - 1);
  if (keep > 0 && code >= 0xd800 && code <= 0xdbff) keep--;
  return `${text.slice(0, keep)}… [clipped ${text.length - keep} chars]`;
}

function clipEntry(entry: LogEntry): { entry: LogEntry; clipped: boolean } {
  let clipped = false;
  const out: Record<string, unknown> = { ...entry };
  for (const key of CLIPPABLE_KEYS) {
    const text = out[key];
    if (typeof text === 'string' && text.length > LOG_ENTRY_MAX_CHARS) {
      out[key] = clipText(text, LOG_ENTRY_MAX_CHARS);
      clipped = true;
    }
  }
  return { entry: out as LogEntry, clipped };
}

// Clip one entry until a snapshot holding only it fits maxChars. The cap is
// on serialized size, and JSON escaping can grow text sixfold (an ANSI escape
// byte serializes as \u001b), so a character cap alone cannot guarantee it.
// Its longest text fields are clipped first; an entry whose `ts` or
// non-text fields alone overflow is returned as clipped as it can be.
function fitEntry(entry: LogEntry, maxChars: number): LogEntry {
  const size = (e: LogEntry) =>
    serializedLength({ items: [e], count: 1, truncated: false });
  const out: Record<string, unknown> = { ...entry };
  // Any text field but `ts`, which the agent needs to resume.
  const keys = Object.keys(out)
    .filter((key) => key !== 'ts' && typeof out[key] === 'string')
    .sort((a, b) => (out[b] as string).length - (out[a] as string).length);
  for (const key of keys) {
    if (size(out as LogEntry) <= maxChars) break;
    const text = (entry as Record<string, unknown>)[key] as string;
    let lo = 0;
    let hi = Math.min(text.length, LOG_ENTRY_MAX_CHARS);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size({ ...out, [key]: clipText(text, mid) } as LogEntry) <= maxChars)
        lo = mid;
      else hi = mid - 1;
    }
    out[key] = clipText(text, lo);
  }
  return out as LogEntry;
}

const entryTs = (entry: LogEntry | undefined) =>
  (entry as { ts?: unknown } | undefined)?.ts;

// Fit the snapshot under maxChars, keeping leading lines. The upstream `since`
// cursor is exclusive (the host drops lines at or before it) and is a bare
// timestamp, while system log lines share whole-second ones, so a cut is
// moved back to a timestamp boundary when the kept part spans more than one:
// resuming from the last kept line's `ts` then skips nothing. The first entry
// is clipped to fit when it must, so a snapshot is never empty and never
// over the cap.
export function fitSnapshot(
  items: LogEntry[],
  truncated: boolean,
  maxChars: number = LOG_SNAPSHOT_MAX_CHARS
): LogSnapshot {
  let cut = truncated;
  const entries = items.map((item) => {
    const { entry, clipped } = clipEntry(item);
    if (clipped) cut = true;
    return entry;
  });
  const snapshot = (n: number, isCut: boolean): LogSnapshot => ({
    items: entries.slice(0, n),
    count: n,
    truncated: isCut,
  });
  const whole = snapshot(entries.length, cut);
  if (entries.length === 0 || serializedLength(whole) <= maxChars) return whole;
  if (serializedLength(snapshot(1, true)) > maxChars) {
    entries[0] = fitEntry(items[0]!, maxChars);
    if (entries.length === 1) return snapshot(1, true);
  }
  let lo = 1;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (serializedLength(snapshot(mid, true)) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  // entries[lo] is the first omitted entry. Back off while it shares a
  // timestamp with the last kept one, unless that would drop every entry.
  let keep = lo;
  const omittedTs = entryTs(entries[keep]);
  if (omittedTs !== undefined) {
    while (keep > 0 && entryTs(entries[keep - 1]) === omittedTs) keep--;
    if (keep === 0) keep = lo;
  }
  return snapshot(keep, true);
}
