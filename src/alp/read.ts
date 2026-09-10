// ALP journal read-back: POST /api/alp/journal (see docs/agent-learning-protocol.md,
// "The tool pair"). The one read path, for the one route that is readable.
//
// SCOPE IS THE TOKEN, NOT THE REQUEST. Identity is resolved from the caller's
// Bearer key exactly as ingest does, and that resolved id is the ONLY filter
// sent to the sink. The request body is read for `limit` and nothing else — an
// `identity` field in it is ignored, so no caller can name whose journal to
// read. Holding a valid key for an account is the only way to see its journal,
// and a key holder already has that account's pods and billing.
//
// FAIL-CLOSED, CALMLY. Anything that prevents a scoped read (no token verdict,
// no sink, sink down, unrecognized reply) returns a non-error result with zero
// entries and a note. It never guesses an identity and never falls back to a
// wider query. Only a missing or invalid credential is a real 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { defaultCredentialChecker } from '../http.js';
import { isSinkUrl } from './ingest.js';

export const DEFAULT_JOURNAL_LIMIT = 20;
export const MAX_JOURNAL_LIMIT = 50;
const SINK_TIMEOUT_MS = 5_000;

export interface JournalEntry {
  content: string;
  intention?: string;
  trigger?: string;
  tool?: string;
  receivedAt: string;
}

interface VerifyResult {
  status: 'valid' | 'invalid' | 'unknown';
  accountId?: string;
}

export interface AlpReadOptions {
  /** Test seams. Production uses the shared checker + global fetch + env. */
  verify?: (token: string) => Promise<VerifyResult>;
  sinkFetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** The read door sits beside the write door on the same Convex deployment. */
export function journalSinkUrl(submitUrl: string): string | null {
  if (!isSinkUrl(submitUrl)) return null;
  const url = new URL(submitUrl);
  url.pathname = '/alp/journal';
  return url.toString();
}

/** Clamp a caller-supplied limit; anything unusable becomes the default. */
export function clampLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_JOURNAL_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_JOURNAL_LIMIT);
}

function unavailable(reason: string): Record<string, unknown> {
  return {
    available: false,
    entries: [],
    note: `Journal unavailable (${reason}). Do not retry — continue your task.`,
  };
}

export async function handleAlpJournalRead(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  opts: AlpReadOptions = {}
): Promise<void> {
  const env = opts.env ?? process.env;
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
  if (!token) {
    send(401, {
      available: false,
      entries: [],
      error: 'Authenticate with your Runpod API key as a Bearer token.',
    });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
    limit?: unknown;
  };
  const limit = clampLimit(body.limit);

  const verify = opts.verify ?? defaultCredentialChecker.verify;
  const verdict = await verify(token);
  if (verdict.status === 'invalid') {
    send(401, {
      available: false,
      entries: [],
      error:
        'This Runpod API key is not valid. Re-authenticate and retry once.',
    });
    return;
  }
  if (verdict.status !== 'valid' || !verdict.accountId) {
    send(200, unavailable('identity could not be resolved right now'));
    return;
  }

  const submitUrl = env.ALP_SINK_URL;
  const sinkSecret = env.ALP_SINK_SECRET;
  const readUrl = submitUrl ? journalSinkUrl(submitUrl) : null;
  if (!submitUrl || !sinkSecret) {
    send(200, unavailable('the journal is not configured on this deployment'));
    return;
  }
  if (!readUrl) {
    console.warn('alp_sink_misconfigured');
    send(200, unavailable('the journal is misconfigured on this deployment'));
    return;
  }

  try {
    const sinkFetch = opts.sinkFetch ?? fetch;
    const response = await sinkFetch(readUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ALP-Secret': sinkSecret,
      },
      // The resolved account id, never anything from the request body.
      body: JSON.stringify({ identity: verdict.accountId, limit }),
      signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn('alp_journal_sink_error', { status: response.status });
      send(200, unavailable('the store did not answer the read'));
      return;
    }
    const sinkBody = (await response.json().catch(() => null)) as {
      ok?: boolean;
      entries?: unknown;
    } | null;
    if (sinkBody?.ok !== true || !Array.isArray(sinkBody.entries)) {
      console.warn('alp_journal_sink_unrecognized', {
        status: response.status,
      });
      send(200, unavailable('the store did not confirm the read'));
      return;
    }
    // Same privacy rule as alp_submit: count, never content.
    console.log(
      'alp_journal_read',
      JSON.stringify({ entries: sinkBody.entries.length, limit })
    );
    send(200, { available: true, entries: sinkBody.entries as JournalEntry[] });
  } catch {
    console.warn('alp_journal_sink_unreachable');
    send(200, unavailable('the store is unreachable right now'));
  }
}
