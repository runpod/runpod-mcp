// ============== CALLER TRACKING (pure header construction) ==============
// The structured User-Agent + session id that identify the calling MCP client
// on every outbound API call. Pure functions here so they're unit-testable
// without the MCP SDK; the SDK-touching part (reading clientInfo off the
// handshake) stays at the call site and is reduced to plain strings before
// reaching `buildTrackingHeaders`.

// Reduces a value to the RFC 9110 token characters (letters, digits and
// !#$%&'*+-.^_`|~) so it can sit inside the structured User-Agent. Every other
// character becomes `_`, one per code point. That keeps out the separators the
// warehouse reader splits on, and everything Fetch refuses in a header value:
// a character above U+00FF or a NUL makes `Headers` throw, which would fail
// every outbound request of a session whose client name holds one. The length
// cap stops a hostile client from inflating the header.
export function sanitizeUaToken(value: string): string {
  return value.replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/gu, '_').slice(0, 64);
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

// Builds the `User-Agent` and `X-Runpod-Session-Id` headers. The User-Agent is
//
//   runpod-mcp-server/<serverVersion> (caller=mcp; surface=v2; client=<name>; client_version=<version>; transport=<stdio|http>)
//
// Runpod's usage analytics parse this header: they file a request under MCP by
// its `runpod-mcp` prefix, take the version from the text after the first `/`,
// and take the calling agent from `client=` up to the next `;` or `)`. The
// prefix, the separators and the key names are a contract with that reader. The clientInfo → fallback → 'unknown' resolution is the
// caller's job (it owns the SDK handle); this function only sanitizes and
// formats the identity it is given.
export function buildTrackingHeaders(
  input: TrackingInput
): Record<string, string> {
  const name = sanitizeUaToken(input.clientName || 'unknown');
  const version = sanitizeUaToken(input.clientVersion || 'unknown');
  // `surface=v2` is the durable generation marker for warehouse attribution
  // (the spec-generated surface; v1 was the hand-written tool set). Bump it
  // with the surface, independently of the npm package version. Keep in sync
  // with SURFACE_VERSION in src/specgen/analytics.ts.
  const userAgent = `runpod-mcp-server/${input.serverVersion} (caller=mcp; surface=v2; client=${name}; client_version=${version}; transport=${input.transport})`;
  return {
    'User-Agent': userAgent,
    'X-Runpod-Session-Id': input.sessionId,
  };
}
