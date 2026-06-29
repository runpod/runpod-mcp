// ============== CALLER TRACKING (pure header construction) ==============
// The structured User-Agent + session id that identify the calling MCP client
// on every outbound API call. Pure functions here so they're unit-testable
// without the MCP SDK; the SDK-touching part (reading clientInfo off the
// handshake) stays at the call site and is reduced to plain strings before
// reaching `buildTrackingHeaders`.

// Sanitizes a value for inclusion in a User-Agent token. RFC 7230 reserves
// parens and a few other chars; strip them so the structured UA stays
// parseable, and bound the length so a hostile client can't blow up a header.
export function sanitizeUaToken(value: string): string {
  return value.replace(/[()<>@,;:\\"/[\]?={}\s]/g, '_').slice(0, 64);
}

export interface TrackingInput {
  // Client identity resolved from the MCP `initialize` handshake's clientInfo,
  // or the inbound HTTP User-Agent as a fallback (stateless HTTP).
  clientName?: string;
  clientVersion?: string;
  transport: 'stdio' | 'http';
  serverVersion: string;
  sessionId: string;
}

// Builds the `User-Agent` + `X-Runpod-Session-Id` headers. The clientInfo →
// fallback → 'unknown' resolution is the caller's job (it owns the SDK handle);
// this function just sanitizes and formats whatever identity it's given.
export function buildTrackingHeaders(
  input: TrackingInput
): Record<string, string> {
  const name = sanitizeUaToken(input.clientName || 'unknown');
  const version = sanitizeUaToken(input.clientVersion || 'unknown');
  const userAgent = `runpod-mcp-server/${input.serverVersion} (caller=mcp; client=${name}; client_version=${version}; transport=${input.transport})`;
  return {
    'User-Agent': userAgent,
    'X-Runpod-Session-Id': input.sessionId,
  };
}
