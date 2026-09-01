// Bounded SSE reader for the v2 log endpoints (GET /v2/pods/{id}/logs and
// GET /v2/serverless/{id}/workers/{workerId}/logs). Both serve
// text/event-stream and hold the connection open to tail live output, so the
// generated JSON dispatch cannot consume them; the curated log tools read a
// time- and byte-bounded snapshot instead. Ported from the official MCP
// server's reader (Apache-2.0, runpod/runpod-mcp).

import { HttpError } from './http-error.js';

// One parsed log frame. A payload that isn't a JSON object is kept verbatim
// under `raw`.
export interface LogEntry {
  source?: string;
  line?: string;
  ts?: string;
  raw?: string;
}

// Parse SSE text into log frames. Events are separated by a blank line; only
// `data:` fields are read (`id:`, `event:`, and `:` comments are ignored). A
// `data:` field may span several lines.
export function parseLogSse(raw: string): LogEntry[] {
  const items: LogEntry[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!dataLines.length) continue;
    const payload = dataLines
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!payload.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      // A bare primitive/array/null (`data: 42`) is not a LogEntry — keep it
      // verbatim rather than pushing a value that violates the shape.
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

export const LOG_STREAM_DEFAULT_WAIT_MS = 5_000;
export const LOG_STREAM_MAX_BYTES = 256 * 1024;

export type SseReader = (
  url: string,
  opts: { maxWaitMs: number; maxBytes: number }
) => Promise<{ raw: string; truncated: boolean }>;

// Time-bounded by maxWaitMs (the stream stays open to tail live output) and
// byte-bounded by maxBytes; whichever fires first aborts and returns what was
// collected. An abort is the NORMAL end of a bounded snapshot — only a non-OK
// HTTP status throws. Bytes are concatenated and decoded once at the end so a
// UTF-8 char split across chunks is never corrupted.
export function createSseReader(
  options: { apiKey?: string; fetchImpl?: typeof fetch } = {}
): SseReader {
  const apiKey = options.apiKey ?? process.env.RUNPOD_API_KEY;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (url, opts) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.maxWaitMs);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let truncated = false;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new HttpError(
          `Runpod API error (${response.status})`,
          response.status,
          await response.text().catch(() => '')
        );
      }
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
          bytes += chunk.length;
          if (bytes >= opts.maxBytes) {
            truncated = true;
            controller.abort();
            break;
          }
        }
      }
    } catch (err) {
      // Abort (timeout or byte cap) is a clean end of a bounded read; anything
      // else (incl. HttpError) propagates.
      if (
        !(
          err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError')
        )
      ) {
        throw err;
      }
    } finally {
      clearTimeout(timer);
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
): Promise<{ items: LogEntry[]; count: number; truncated: boolean }> {
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
  const items = parseLogSse(raw);
  // A byte-cap truncation almost always slices the final frame mid-line, so
  // the last parsed entry is a partial. Drop it when truncated — the flag
  // already signals output was cut, so over-trimming one boundary line is
  // acceptable and never misleading.
  if (truncated) items.pop();
  return { items, count: items.length, truncated };
}
