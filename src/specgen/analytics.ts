// Anonymous product analytics (PostHog), hosted-path only.
//
// OFF BY DEFAULT: every capture is a no-op unless POSTHOG_API_KEY is set —
// it never is locally or in CI, so only a deployment that deliberately sets
// it (the Vercel project) sends anything. Users opt out per client with the
// `X-Runpod-Analytics: off` header (see README), and the stdio transport
// never captures at all.
//
// SECURITY: the event payload is the closed set of fields in ToolCallEvent,
// ResourceEvent and LoopBlockedEvent — never the API key, the Authorization header, resource ids,
// or response payloads. Tool arguments are dropped unless the tool names them
// in CuratedTool.recordedArguments; only the bundled guide and concept tools
// do, and their arguments are guide ids, concept names and search words. The caller identity is an HMAC of the key with a
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
  /** Argument values the tool allowlists (CuratedTool.recordedArguments),
   *  already passed through recordedArgumentValues. Sent as arg_<name>. */
  args?: Record<string, string>;
  /** Kind of the guide read-guide resolved: skill, reference or golden-path. */
  guideKind?: string;
  /** Set when this server's own limiter denied the call (not an API 429). */
  blockedBy?: string;
  /** The tool surface the call came through: `directory` for the app
   *  directories (mcp.runpod.io/directory), `default` for everything else. */
  profile?: 'default' | 'directory';
}

/** The hosted 404 loop breaker started blocking one account + tool. */
export interface LoopBlockedEvent {
  tool: string;
  blockedForS: number;
  transport: 'stdio' | 'http';
  serverVersion: string;
  clientName?: string;
  accountId?: string;
}

/** A resources/read request. `uri` is the served guide URI, or 'unknown'
 *  on a miss so arbitrary client strings never land in events. */
export interface ResourceEvent {
  method: 'resources/read';
  uri: string;
  ok: boolean;
  transport: 'stdio' | 'http';
  serverVersion: string;
  clientName?: string;
  accountId?: string;
}

const CAPTURE_TIMEOUT_MS = 3_000;

// Durable generation marker for v1-vs-v2 attribution, independent of the npm
// package version: '2' is the spec-generated surface (v1 was the hand-written
// tool set). Bump on surface generations ('3') or notable revisions ('2.1').
// Keep in sync with the `surface=` User-Agent token in _shared/tracking.ts.
export const SURFACE_VERSION = '2';

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

// Longest recorded argument or URI. Guide ids and concept names are far
// shorter; the cap bounds what a client can push into an event.
const MAX_RECORDED_VALUE_LENGTH = 200;

function bounded(value: string): string {
  return value.slice(0, MAX_RECORDED_VALUE_LENGTH);
}

// Picks the allowlisted argument values off a tool call. Only strings and
// numbers are kept, so an object-shaped argument can never be serialized in.
export function recordedArgumentValues(
  names: readonly string[] | undefined,
  args: Record<string, unknown>
): Record<string, string> | undefined {
  if (!names?.length) return undefined;
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' || typeof value === 'number') {
      values[name] = bounded(String(value).trim());
    }
  }
  return Object.keys(values).length ? values : undefined;
}

// Fire-and-forget: never throws, never blocks the response. A lost event is
// fine; a failed tool call because of analytics is not.
function capture(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>
): void {
  const posthogKey = process.env.POSTHOG_API_KEY;
  if (!posthogKey) return;
  void fetch(`${posthogHost()}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: posthogKey,
      event,
      distinct_id: distinctId,
      timestamp: new Date().toISOString(),
      properties: {
        ...properties,
        surface_version: SURFACE_VERSION,
        $process_person_profile: false,
      },
    }),
    signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
  }).catch(() => {
    // Dropped events are acceptable; noisy logs on every blip are not.
  });
}

export function captureToolCall(
  apiKey: string | undefined,
  event: ToolCallEvent
): void {
  const args = Object.fromEntries(
    Object.entries(event.args ?? {}).map(([name, value]) => [
      `arg_${name}`,
      value,
    ])
  );
  capture('runpod_mcp_tool_call', analyticsCallerId(apiKey, event.accountId), {
    tool: event.tool,
    ok: event.ok,
    status: event.status,
    duration_ms: event.durationMs,
    transport: event.transport,
    server_version: event.serverVersion,
    ...(event.clientName ? { client_name: event.clientName } : {}),
    ...(event.guideKind ? { guide_kind: event.guideKind } : {}),
    ...(event.blockedBy ? { blocked_by: event.blockedBy } : {}),
    ...(event.profile ? { profile: event.profile } : {}),
    ...args,
  });
}

export function captureLoopBlocked(
  apiKey: string | undefined,
  event: LoopBlockedEvent
): void {
  capture(
    'runpod_mcp_loop_blocked',
    analyticsCallerId(apiKey, event.accountId),
    {
      tool: event.tool,
      blocked_for_s: event.blockedForS,
      transport: event.transport,
      server_version: event.serverVersion,
      ...(event.clientName ? { client_name: event.clientName } : {}),
    }
  );
}

export function captureResourceCall(
  apiKey: string | undefined,
  event: ResourceEvent
): void {
  capture(
    'runpod_mcp_resource_call',
    analyticsCallerId(apiKey, event.accountId),
    {
      method: event.method,
      uri: bounded(event.uri),
      ok: event.ok,
      transport: event.transport,
      server_version: event.serverVersion,
      ...(event.clientName ? { client_name: event.clientName } : {}),
    }
  );
}
