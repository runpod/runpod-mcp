// Anonymous product analytics (PostHog), hosted-path only.
//
// OFF BY DEFAULT: every capture is a no-op unless POSTHOG_API_KEY is set —
// it never is locally or in CI, so only a deployment that deliberately sets
// it (the Vercel project) sends anything. Users opt out per client with the
// `X-Runpod-Analytics: off` header (see README), and the stdio transport
// never captures at all.
//
// SECURITY: the event payload is the closed set of fields in ToolCallEvent —
// never the API key, the Authorization header, tool arguments, resource ids,
// or response payloads. The caller identity is an HMAC of the key with a
// server-side salt (MCP_ANALYTICS_SALT): stable across instances so per-user
// frequency works in PostHog, irreversible without the salt, and never
// joinable to the key itself. $process_person_profile stays false — no
// person profiles, just anonymous distinct ids.

import { createHmac } from 'node:crypto';

export interface ToolCallEvent {
  tool: string;
  ok: boolean;
  status: number;
  durationMs: number;
  transport: 'stdio' | 'http';
  serverVersion: string;
  /** Sanitized client token from the User-Agent (never the raw header). */
  clientName?: string;
  /** Stable account id (the pre-flight's myself.id). Preferred identity:
   *  keys rotate on every OAuth sign-in, the account does not. Hashed like
   *  the key — the raw id never leaves the process. */
  accountId?: string;
}

const CAPTURE_TIMEOUT_MS = 3_000;

function posthogHost(): string {
  return process.env.POSTHOG_HOST || 'https://us.i.posthog.com';
}

// Stable anonymous caller id. Identity source, best first: the account id
// (stable across key rotations and OAuth re-auths), then the API key (a
// per-key identity is better than none when the pre-flight was skipped).
// Without MCP_ANALYTICS_SALT the HMAC key falls back to the PostHog key —
// still server-side and secret, so the id stays non-reversible; set the salt
// to rotate identities independently of the PostHog project.
export function analyticsCallerId(
  apiKey: string | undefined,
  accountId?: string
): string {
  const identity = accountId ?? apiKey;
  if (!identity) return 'anonymous';
  const salt =
    process.env.MCP_ANALYTICS_SALT || process.env.POSTHOG_API_KEY || '';
  const prefix = accountId ? 'a:' : 'k:';
  return (
    prefix +
    createHmac('sha256', salt).update(identity).digest('hex').slice(0, 16)
  );
}

// Fire-and-forget: never throws, never blocks the tool response. A lost
// event is fine; a failed tool call because of analytics is not.
export function captureToolCall(
  apiKey: string | undefined,
  event: ToolCallEvent
): void {
  const posthogKey = process.env.POSTHOG_API_KEY;
  if (!posthogKey) return;
  void fetch(`${posthogHost()}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: posthogKey,
      event: 'mcp_tool_call',
      distinct_id: analyticsCallerId(apiKey, event.accountId),
      timestamp: new Date().toISOString(),
      properties: {
        tool: event.tool,
        ok: event.ok,
        status: event.status,
        duration_ms: event.durationMs,
        transport: event.transport,
        server_version: event.serverVersion,
        ...(event.clientName ? { client_name: event.clientName } : {}),
        $process_person_profile: false,
      },
    }),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  }).catch(() => {
    // Dropped events are acceptable; noisy logs on every blip are not.
  });
}
