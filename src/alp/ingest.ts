// ALP ingest endpoint: POST /api/alp/submit (see docs/agent-learning-protocol.md).
//
// The ONE write path for all three ALP routes on BOTH transports — the npm
// package cannot hold storage credentials, so local stdio and the hosted
// server alike submit here, authenticated with the caller's own Runpod key.
//
// Behavior per request: authenticate → resolve the durable identity (never
// key on the API key; see the design doc) → courtesy scrub → forward to the
// private sink with the shared server secret. The sink (a Convex HTTP action
// in a private repo) owns storage, the authoritative scrub, and everything
// downstream. When no sink is configured this endpoint answers honestly that
// nothing was recorded — it never pretends.
//
// FAIL-SOFT CONTRACT: whatever goes wrong (no sink, sink down, identity
// unresolvable), the response is a calm 200 with { recorded: false } and an
// instruction not to retry. ALP is a side quest; it must never derail the
// agent's actual task or invite retry loops. Only a missing/invalid
// credential is a real 401 — that is actionable by re-authenticating.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { defaultCredentialChecker } from '../http.js';
import { scrub, SCRUB_VERSION } from './scrub.js';

export const ALP_ROUTES = ['feedback', 'journal', 'question'] as const;
export type AlpRoute = (typeof ALP_ROUTES)[number];

const MAX_CONTENT_CHARS = 20_000;
const MAX_FIELD_CHARS = 500;
const SINK_TIMEOUT_MS = 5_000;

export interface AlpSubmitBody {
  route: AlpRoute;
  content: string;
  intention?: string;
  modelType?: string;
  harness?: string;
  harnessSource?: 'client_info' | 'user_agent';
  transport?: 'stdio' | 'http';
}

interface VerifyResult {
  status: 'valid' | 'invalid' | 'unknown';
  accountId?: string;
}

export interface AlpIngestOptions {
  /** Test seams. Production uses the shared checker + global fetch + env. */
  verify?: (token: string) => Promise<VerifyResult>;
  sinkFetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

function notRecorded(reason: string): Record<string, unknown> {
  return {
    recorded: false,
    note: `Not recorded (${reason}). Do not retry — continue your task.`,
  };
}

export async function handleAlpSubmit(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse & {
    status?: (code: number) => { json: (body: unknown) => void };
  },
  opts: AlpIngestOptions = {}
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
      recorded: false,
      error: 'Authenticate with your Runpod API key as a Bearer token.',
    });
    return;
  }

  const body = (
    req.body && typeof req.body === 'object' ? req.body : {}
  ) as Partial<AlpSubmitBody>;
  if (
    !ALP_ROUTES.includes(body.route as AlpRoute) ||
    typeof body.content !== 'string' ||
    body.content.trim().length === 0
  ) {
    send(400, {
      recorded: false,
      error: `Body must carry route (${ALP_ROUTES.join('|')}) and a non-empty content string.`,
    });
    return;
  }

  // Resolve the durable identity. A dead key is a real 401 (re-auth fixes
  // it); an unreachable auth backend is fail-soft (we cannot key the row).
  const verify = opts.verify ?? defaultCredentialChecker.verify;
  const verdict = await verify(token);
  if (verdict.status === 'invalid') {
    send(401, {
      recorded: false,
      error:
        'This Runpod API key is not valid. Re-authenticate and retry once.',
    });
    return;
  }
  if (verdict.status !== 'valid' || !verdict.accountId) {
    send(200, notRecorded('identity could not be resolved right now'));
    return;
  }

  const sinkUrl = env.ALP_SINK_URL;
  const sinkSecret = env.ALP_SINK_SECRET;
  if (!sinkUrl || !sinkSecret) {
    send(200, notRecorded('ingest is not configured on this deployment'));
    return;
  }

  const content = scrub(body.content.slice(0, MAX_CONTENT_CHARS));
  const intention =
    typeof body.intention === 'string'
      ? scrub(body.intention.slice(0, MAX_FIELD_CHARS))
      : undefined;

  const row = {
    route: body.route,
    content: content.text,
    intention: intention?.text,
    modelType:
      typeof body.modelType === 'string'
        ? body.modelType.slice(0, MAX_FIELD_CHARS)
        : undefined,
    identity: verdict.accountId,
    harness:
      typeof body.harness === 'string'
        ? body.harness.slice(0, MAX_FIELD_CHARS)
        : undefined,
    harnessSource: body.harnessSource,
    transport: body.transport,
    redactions: content.redactions + (intention?.redactions ?? 0),
    scrubVersion: SCRUB_VERSION,
    receivedAt: new Date().toISOString(),
  };

  // Awaited, not fire-and-forget: Vercel can freeze the function the moment
  // the response returns, so an unawaited write may silently vanish.
  try {
    const sinkFetch = opts.sinkFetch ?? fetch;
    const response = await sinkFetch(sinkUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ALP-Secret': sinkSecret,
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(SINK_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn('alp_sink_error', { status: response.status });
      send(200, notRecorded('the store did not accept the write'));
      return;
    }
  } catch {
    console.warn('alp_sink_unreachable');
    send(200, notRecorded('the store is unreachable right now'));
    return;
  }

  // One log line, same privacy rules as tool_call: never the content.
  console.log(
    'alp_submit',
    JSON.stringify({
      route: body.route,
      transport: body.transport,
      redactions: row.redactions,
    })
  );
  send(200, { recorded: true });
}
