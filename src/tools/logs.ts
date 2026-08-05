import { z } from 'zod';
import { EXPIRED_CREDENTIAL_HINT, HttpError } from '../_shared/http.js';
import { rateLimitHint } from '../_shared/rate-limit.js';
import type { Backend, Resource } from '../_shared/backend.js';
import type { StreamSse, ToolRuntime } from './runtime.js';

// ============== SHARED LOG STREAMING ==============
// Pod logs (GET /v2/pods/{id}/logs) and worker logs
// (GET /v2/serverless/{id}/workers/{workerId}/logs) are the same feature on two
// resources: an SSE stream of `data: {source,line,ts}` frames. This module holds
// everything they share — the frame parser, the param schema, the bounded read,
// and the tool handler — so each tool registration is just a name + a URL.

// One parsed log frame. A payload that isn't JSON is kept verbatim under `raw`.
export interface LogEntry {
  source?: string;
  line?: string;
  ts?: string;
  raw?: string;
}

// Parse SSE text into log frames. Pure, so it's unit-tested without a network.
// Events are separated by a blank line; only `data:` fields are read (`id:`,
// `event:`, and `:` comments are ignored). A `data:` field may span several lines.
export function parseLogSse(raw: string): LogEntry[] {
  const items: LogEntry[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!dataLines.length) continue;
    // Drop the `data:` prefix and one optional leading space from each line.
    const payload = dataLines
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!payload.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      // A log frame is a JSON object; a bare primitive/array/null (`data: 42`)
      // is not a LogEntry, so keep it verbatim under `raw` rather than pushing a
      // value that violates the LogEntry shape.
      items.push(
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as LogEntry)
          : { raw: payload }
      );
    } catch {
      items.push({ raw: payload });
    }
  }
  return items;
}

// How long to hold the stream open, and the byte cap that flips `truncated`.
export const LOG_STREAM_DEFAULT_WAIT_MS = 5000;
export const LOG_STREAM_MAX_BYTES = 256 * 1024;

// Minimal structural shape of the fetch response the SSE reader consumes. Kept
// deliberately narrow so both node-fetch (production) and a test fake satisfy it
// without pulling in a full Response type.
export interface SseResponse {
  ok: boolean;
  status: number;
  // Read only for the 429 rate-limit hint. Required, so a fake that omits it
  // is an editor error — `pnpm type-check` excludes `**/*.test.ts`, so nothing
  // in CI enforces it. The one production caller casts global `fetch`
  // (`as unknown as SseFetch`), whose Response always carries headers.
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body: AsyncIterable<Buffer> | null;
}
export type SseFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal }
) => Promise<SseResponse>;

// The real bounded SSE reader, extracted so it can be unit-tested against a mock
// Response (production wires it to node-fetch in createToolRuntime). Time-bounded
// by maxWaitMs (the stream may stay open to tail live output) and byte-bounded by
// maxBytes; whichever fires first aborts and returns what was collected so far.
// A timeout/cap abort is a NORMAL end of a bounded snapshot — whether it fires
// while CONNECTING (thrown from the `await fetchImpl`) or mid body read, keep the
// collected bytes rather than throwing. Only a non-OK HTTP status throws
// (HttpError). Buffers are concatenated and decoded ONCE at the end so a UTF-8
// char split across two network chunks is never corrupted.
export async function readSseSnapshot(
  fetchImpl: SseFetch,
  url: string,
  headers: Record<string, string>,
  opts: { maxWaitMs: number; maxBytes: number }
): Promise<{ raw: string; truncated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.maxWaitMs);
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new HttpError(
        'Runpod API Error',
        res.status,
        await res.text().catch(() => ''),
        // This throw bypasses createHttpClient, so the status hints are built
        // here too or these two tools alone return a bare 429/401. The 401
        // hint applies: this request always carries Authorization (see the
        // headers bound in runtime.ts streamSse).
        res.status === 429
          ? rateLimitHint(
              res.headers.get('ratelimit'),
              res.headers.get('retry-after')
            )
          : res.status === 401
            ? EXPIRED_CREDENTIAL_HINT
            : undefined
      );
    }
    for await (const chunk of (res.body ?? []) as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes >= opts.maxBytes) {
        truncated = true;
        controller.abort();
        break;
      }
    }
  } catch (err) {
    // Abort (timeout or byte-cap) is a clean end of a bounded read — keep what we
    // have. Anything else (incl. HttpError on a non-OK status) propagates.
    if (!(err instanceof Error && err.name === 'AbortError')) throw err;
  } finally {
    clearTimeout(timer);
  }
  return { raw: Buffer.concat(chunks).toString('utf8'), truncated };
}

// Zod params shared by both log tools; spread in alongside the resource id.
export const logStreamParams = {
  source: z
    .enum(['container', 'system', 'both'])
    .optional()
    .describe('Which log source to read (default: both)'),
  tail: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe(
      'Historical lines to backfill before live output (API default 100, max 5000; 0 = live only). Ignored when `since` is set.'
    ),
  since: z
    .string()
    .optional()
    .describe('RFC3339 timestamp to resume from; when set, `tail` is ignored.'),
  maxWaitMs: z
    .number()
    .int()
    .min(500)
    .max(30000)
    .optional()
    .describe('How long to read the stream, in ms (default 5000, max 30000)'),
} as const;

export interface LogStreamParams {
  source?: 'container' | 'system' | 'both';
  tail?: number;
  since?: string;
  maxWaitMs?: number;
}

// Read a bounded snapshot of a log endpoint and return the parsed frames.
// `source: 'both'` (or omitted) sends no `source` param — the endpoint returns
// both streams when it's absent (the wire enum is only container|system).
// Throws HttpError on a non-OK response.
export async function collectLogSnapshot(
  streamSse: StreamSse,
  logsUrl: string,
  params: LogStreamParams
): Promise<{ items: LogEntry[]; count: number; truncated: boolean }> {
  const qs = new URLSearchParams();
  if (params.source && params.source !== 'both')
    qs.append('source', params.source);
  if (params.tail !== undefined) qs.append('tail', String(params.tail));
  if (params.since) qs.append('since', params.since);
  const query = qs.toString() ? `?${qs}` : '';
  const { raw, truncated } = await streamSse(`${logsUrl}${query}`, {
    maxWaitMs: params.maxWaitMs ?? LOG_STREAM_DEFAULT_WAIT_MS,
    maxBytes: LOG_STREAM_MAX_BYTES,
  });
  const items = parseLogSse(raw);
  // A byte-cap truncation almost always slices the final frame mid-line, so the
  // last parsed entry is a partial (typically garbage half-JSON kept under
  // `raw`). Drop it when truncated so callers never see a corrupt trailing
  // frame; `truncated: true` already signals output was cut.
  //
  // The pop is unconditional: in the rare case the cap lands exactly on a frame
  // boundary (or the final bytes were a non-`data:` block that produced no
  // entry), this drops one *valid* trailing line instead of a garbage one. That
  // over-trim is acceptable — `truncated: true` already tells the caller output
  // was cut, so losing one more line at the boundary is not misleading.
  if (truncated) items.pop();
  return { items, count: items.length, truncated };
}

// The full handler for a log tool: resolve the backend, gate v2-only, stream a
// snapshot, and map an HTTP error to a JSON reply. `logsUrl` builds the endpoint
// URL from the resolved backend (the resource id is closed over by the caller).
export async function streamLogsReply(
  rt: Pick<ToolRuntime, 'jsonReply' | 'backendFor' | 'streamSse'>,
  tool: {
    name: string;
    resource: Resource;
    logsUrl: (backend: Backend) => string;
  },
  params: LogStreamParams
) {
  const backend = rt.backendFor(tool.resource);
  if (backend.version === 'v1') {
    return rt.jsonReply({
      error: `${tool.name} is only available on the v2 REST API. Set RUNPOD_REST_VERSION=v2.`,
      status: 501,
    });
  }
  try {
    return rt.jsonReply(
      await collectLogSnapshot(rt.streamSse, tool.logsUrl(backend), params)
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return rt.jsonReply({ error: error.message, status: error.status });
    }
    throw error;
  }
}
