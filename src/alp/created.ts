// Creation counter regression seam: the server no longer asks: after each successful call of a
// creation tool (CREATION_TOOLS) for a resolved account, the hosted server
// reports it to the sink and gets the account's running count back
// (docs/agent-learning-protocol.md, "RT5"). The sink counts per account, not
// per session: the hosted transport is stateless, so there is no session to
// count in. Server-internal like the once-per-account lookup: not an HTTP
// endpoint of the deployment and no tool calls it, and the sink call is
// secret-gated with the same single-caller property.
//
// FAIL-SOFT, TOWARD SILENCE. Any failure (no sink, sink down, unrecognized
// reply, timeout) returns null, and the caller adds no note: without a count
// there is no third creation to ask on. The tool result never depends on it.

import { sinkRouteUrl, type CreationTool } from './sink.js';

// On a creation's response path, so as short as the handshake lookup: a slow
// sink delays the result by at most this much before the note is skipped.
const CREATED_TIMEOUT_MS = 2_500;

// The threshold the removed NPS ask used; kept as the regression seam's count.
export const NPS_ASK_MIN_CREATIONS = 3;

export interface CreatedOptions {
  /** Test seams. Production uses the global fetch + env. */
  sinkFetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export async function recordCreation(
  identity: string,
  tool: CreationTool,
  opts: CreatedOptions = {}
): Promise<number | null> {
  const env = opts.env ?? process.env;
  const submitUrl = env.ALP_SINK_URL;
  const sinkSecret = env.ALP_SINK_SECRET;
  if (!identity || !submitUrl || !sinkSecret) return null;
  // The counter sits beside the write door on the same Convex deployment.
  const url = sinkRouteUrl(submitUrl, '/alp/created');
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
      // The resolved account id and the tool name, nothing from the call.
      body: JSON.stringify({ identity, tool }),
      signal: AbortSignal.timeout(CREATED_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn('alp_created_sink_error', { status: response.status });
      return null;
    }
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      count?: unknown;
    } | null;
    if (
      body?.ok !== true ||
      typeof body.count !== 'number' ||
      !Number.isInteger(body.count)
    ) {
      console.warn('alp_created_sink_unrecognized', {
        status: response.status,
      });
      return null;
    }
    return body.count;
  } catch {
    console.warn('alp_created_sink_unreachable');
    return null;
  }
}
