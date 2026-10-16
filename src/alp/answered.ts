// Once-per-account lookup: has this account already made its one submission
// on a route that takes a single answer per account? The hosted handshake
// asks this for the referral route so the "how did your user end up on
// Runpod" prompt reaches an account once, not every session
// (docs/agent-learning-protocol.md, "RT4"). Server-internal: this is not an
// HTTP endpoint of the deployment and no tool calls it. The sink call is
// secret-gated with the same single-caller property as ingest and the
// journal read.
//
// FAIL-SOFT, TOWARD ASKING. Any failure (no sink, sink down, unrecognized
// reply, timeout) returns null, and the caller treats null as "not known to
// have answered" and keeps the prompt. The sink's own dedupe at write time is
// the backstop, so a wrong guess here costs the agent one tool call that
// answers already_submitted — never a duplicate row.

import { sinkRouteUrl, type OncePerAccountRoute } from './sink.js';

// On the handshake path, so shorter than the write-path deadline: a slow sink
// delays initialize by at most this much before the prompt is simply kept.
const ANSWERED_TIMEOUT_MS = 2_500;

export interface AnsweredOptions {
  /** Test seams. Production uses the global fetch + env. */
  sinkFetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export async function hasAnswered(
  identity: string,
  route: OncePerAccountRoute,
  opts: AnsweredOptions = {}
): Promise<boolean | null> {
  const env = opts.env ?? process.env;
  const submitUrl = env.ALP_SINK_URL;
  const sinkSecret = env.ALP_SINK_SECRET;
  if (!identity || !submitUrl || !sinkSecret) return null;
  // The lookup door sits beside the write door on the same Convex deployment.
  const url = sinkRouteUrl(submitUrl, '/alp/answered');
  if (!url) {
    console.warn('alp_sink_misconfigured');
    return null;
  }
  try {
    const sinkFetch = opts.sinkFetch ?? fetch;
    const response = await sinkFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ALP-Secret': sinkSecret,
      },
      // The resolved account id and the route, nothing from any request body.
      body: JSON.stringify({ identity, route }),
      signal: AbortSignal.timeout(ANSWERED_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn('alp_answered_sink_error', { status: response.status });
      return null;
    }
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      answered?: unknown;
    } | null;
    if (body?.ok !== true || typeof body.answered !== 'boolean') {
      console.warn('alp_answered_sink_unrecognized', {
        status: response.status,
      });
      return null;
    }
    return body.answered;
  } catch {
    console.warn('alp_answered_sink_unreachable');
    return null;
  }
}
