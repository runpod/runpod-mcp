// ALP ingest endpoint: POST /api/alp/submit (see docs/agent-learning-protocol.md).
//
// The shared write path for the four hosted ALP write tools.
// Local stdio does not register these tools.
//
// Behavior per request: authenticate → resolve the durable identity (never
// key on the API key; see the design doc) → courtesy scrub → forward to the
// private sink with the shared server secret. The sink (a Convex HTTP action
// in convex/ in this repo) owns storage, the authoritative scrub, and everything
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
import { scrubSubmission, SCRUB_VERSION } from './scrub.js';
import {
  ALP_REFERRAL_SOURCES,
  ALREADY_SUBMITTED_NOTE,
  isSinkUrl,
  type AlpReferralSource,
} from './sink.js';

export const ALP_ROUTES = [
  'feedback',
  'journal',
  'question',
  'referral',
] as const;
export type AlpRoute = (typeof ALP_ROUTES)[number];

const MAX_CONTENT_CHARS = 20_000;
// The referral answer is a sentence or two by contract (CON-1762: never a
// conversation log), so it gets a cap a log cannot fit in.
export const MAX_REFERRAL_CONTENT_CHARS = 2_000;
const MAX_FIELD_CHARS = 500;
const SINK_TIMEOUT_MS = 5_000;

export const ALP_SEVERITIES = ['blocked', 'degraded', 'cosmetic'] as const;
export type AlpSeverity = (typeof ALP_SEVERITIES)[number];

export interface AlpSubmitBody {
  route: AlpRoute;
  content: string;
  intention?: string;
  modelType?: string;
  /** Triage dimension, feedback route. Constrained so it stays sortable. */
  severity?: AlpSeverity;
  /** The tool the entry is about, as it appears in the agent's tool list. */
  tool?: string;
  /** Feedback route: what the agent did instead. Absent means fully blocked. */
  workaround?: string;
  /** Journal route: the situation in which to recall the entry. */
  trigger?: string;
  /** Referral route: why Runpod came up. Constrained so it stays countable. */
  source?: AlpReferralSource;
  /** Referral route: the agent had no context on how the user found Runpod. */
  noContext?: boolean;
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
  const content = typeof body.content === 'string' ? body.content : '';
  const referral = body.route === 'referral';
  // Referral route only: a no-context answer is complete without content. The
  // tool asks for a few words with it, but a terse agent may send noContext
  // alone, and a 400 there would leave the account's one slot open and the
  // ask repeating every session. The flag is normalized leniently (true, 1,
  // any casing of "true") because the first answer closes the slot and a
  // sloppy no-context call must not be stored as a real one.
  const rawNoContext = body.noContext as unknown;
  const noContextAnswer =
    referral &&
    (rawNoContext === true ||
      rawNoContext === 1 ||
      (typeof rawNoContext === 'string' &&
        rawNoContext.trim().toLowerCase() === 'true'));
  if (
    !ALP_ROUTES.includes(body.route as AlpRoute) ||
    (content.trim().length === 0 && !noContextAnswer)
  ) {
    send(400, {
      recorded: false,
      error: `Body must carry route (${ALP_ROUTES.join('|')}) and a non-empty content string (or, on referral, noContext true).`,
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
  // Refuse a sink URL that is not shaped like the sink. The sink is always a
  // Convex HTTP action, so anything else is a config error, and a loud log
  // line beats inferring it from a table later. Note the limit of this check:
  // it cannot tell one Convex deployment from another, so it catches a
  // malformed or foreign URL, never a valid URL aimed at the wrong
  // environment. Separating the per-environment secrets is what covers that.
  if (!isSinkUrl(sinkUrl)) {
    console.warn('alp_sink_misconfigured');
    send(200, notRecorded('ingest is misconfigured on this deployment'));
    return;
  }

  // Scrub before truncation so cutting a token cannot hide its shape.
  const clean = scrubSubmission({
    content,
    // Feedback/journal/question fields are not stored on the referral route
    // even if a client sends them: the tool does not offer them, and the
    // route's 2,000-character cap would mean nothing if a transcript could
    // ride in `trigger` or `workaround` under the general cap instead.
    intention:
      !referral && typeof body.intention === 'string'
        ? body.intention
        : undefined,
    modelType: typeof body.modelType === 'string' ? body.modelType : undefined,
    // Drop an off-enum severity rather than storing it. The whole value of the
    // field is that it can be sorted and counted; one free-text variant
    // ("critical", "high") turns a dimension back into prose, and the loss of
    // one label costs less than that.
    severity:
      !referral && ALP_SEVERITIES.includes(body.severity as AlpSeverity)
        ? (body.severity as AlpSeverity)
        : undefined,
    tool: !referral && typeof body.tool === 'string' ? body.tool : undefined,
    workaround:
      !referral && typeof body.workaround === 'string'
        ? body.workaround
        : undefined,
    trigger:
      !referral && typeof body.trigger === 'string' ? body.trigger : undefined,
    // Referral-only fields. source follows the severity rule (off-enum is
    // dropped, not stored as prose) and is dropped on a no-context answer,
    // which by definition has no source. noContext is always a boolean on the
    // route so the share of answers with real context is one filter.
    source:
      referral &&
      !noContextAnswer &&
      ALP_REFERRAL_SOURCES.includes(body.source as AlpReferralSource)
        ? (body.source as AlpReferralSource)
        : undefined,
    noContext: referral ? noContextAnswer : undefined,
    harness: typeof body.harness === 'string' ? body.harness : undefined,
    harnessSource:
      typeof body.harnessSource === 'string' ? body.harnessSource : undefined,
    transport:
      body.transport === 'http' || body.transport === 'stdio'
        ? body.transport
        : undefined,
    redactions: 0,
    scrubVersion: SCRUB_VERSION,
  });
  const row = {
    ...clean,
    route: body.route,
    content: clean.content.slice(
      0,
      referral ? MAX_REFERRAL_CONTENT_CHARS : MAX_CONTENT_CHARS
    ),
    intention: clean.intention?.slice(0, MAX_FIELD_CHARS),
    modelType: clean.modelType?.slice(0, MAX_FIELD_CHARS),
    severity: clean.severity,
    tool: clean.tool?.slice(0, MAX_FIELD_CHARS),
    // Prose fields, so they get the content cap rather than the field cap: a
    // workaround worth reading is a paragraph, not a label.
    workaround: clean.workaround?.slice(0, MAX_CONTENT_CHARS),
    trigger: clean.trigger?.slice(0, MAX_CONTENT_CHARS),
    source: clean.source,
    noContext: clean.noContext,
    harness: clean.harness?.slice(0, MAX_FIELD_CHARS),
    harnessSource: clean.harnessSource?.slice(0, MAX_FIELD_CHARS),
    transport: clean.transport?.slice(0, MAX_FIELD_CHARS),
    identity: verdict.accountId,
    receivedAt: new Date().toISOString(),
  };

  // Awaited, not fire-and-forget: Vercel can freeze the function the moment
  // the response returns, so an unawaited write may silently vanish.
  let storedId: string;
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
    // A 200 is not enough. Any misconfigured sink host answers 200 to a POST
    // (a static page, a redirect target, another app's root), and treating
    // that as success reports recorded: true while nothing is stored — a
    // silent data loss that no log line and no ack can distinguish from a
    // real write. This is defense in depth, not a fix for an observed
    // incident: require the sink's own contract, { ok: true, id }, so that
    // "recorded" can only mean a row exists.
    const sinkBody = (await response.json().catch(() => null)) as {
      ok?: boolean;
      id?: string;
      duplicate?: boolean;
    } | null;
    if (sinkBody?.ok !== true || typeof sinkBody.id !== 'string') {
      console.warn('alp_sink_unrecognized', { status: response.status });
      send(200, notRecorded('the store did not confirm the write'));
      return;
    }
    if (sinkBody.duplicate === true) {
      // A once-per-account route already holds this identity's answer; the
      // sink kept the existing row and stored nothing. Named as its own
      // reason rather than folded into the generic not-recorded note: that
      // note reads as a transient failure, and this must not invite a later
      // session to try again.
      console.log(
        'alp_submit_duplicate',
        JSON.stringify({
          route: body.route,
          transport: row.transport,
          row: sinkBody.id,
        })
      );
      send(200, {
        recorded: false,
        reason: 'already_submitted',
        note: ALREADY_SUBMITTED_NOTE,
      });
      return;
    }
    storedId = sinkBody.id;
  } catch {
    console.warn('alp_sink_unreachable');
    send(200, notRecorded('the store is unreachable right now'));
    return;
  }

  // One log line, same privacy rules as tool_call: never the content.
  // `row` is the sink's own document id: the one field here that cannot exist
  // unless a write actually happened. Everything else was known before the
  // request went out, which is why the old log line looked healthy while
  // nothing was being stored.
  console.log(
    'alp_submit',
    JSON.stringify({
      route: body.route,
      transport: row.transport,
      redactions: row.redactions,
      row: storedId,
    })
  );
  send(200, { recorded: true });
}
