import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const PREFIX = 'mcpv1';

function signingKey(): Buffer {
  const hex = process.env.MCP_OAUTH_SIGNING_KEY;
  if (!hex || !/^[a-fA-F0-9]{64,}$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(
      'MCP_OAUTH_SIGNING_KEY must be at least 32 random bytes encoded as hex'
    );
  }
  return Buffer.from(hex, 'hex');
}

function sign(kind: string, value: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${PREFIX}.${kind}.${body}`;
  const mac = createHmac('sha256', signingKey())
    .update(data)
    .digest('base64url');
  return `${data}.${mac}`;
}

function verify(value: string, kind: string): Record<string, unknown> | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX || parts[1] !== kind)
    return null;
  const data = parts.slice(0, 3).join('.');
  const actual = Buffer.from(parts[3], 'base64url');
  const expected = createHmac('sha256', signingKey()).update(data).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;
  try {
    const decoded = JSON.parse(Buffer.from(parts[2], 'base64url').toString());
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
}

export function registerClient(
  redirectUris: string[],
  clientName: string
): string {
  return sign('client', {
    redirectUris,
    clientName: clientName.slice(0, 100),
    nonce: randomUUID(),
  });
}

export function registeredRedirects(clientId: string): string[] | null {
  const payload = verify(clientId, 'client');
  if (!payload || !Array.isArray(payload.redirectUris)) return null;
  if (
    payload.redirectUris.length < 1 ||
    payload.redirectUris.length > 5 ||
    !payload.redirectUris.every((uri) => typeof uri === 'string')
  ) {
    return null;
  }
  return payload.redirectUris;
}

export function createHandoffState(
  requestId: string,
  redirectUri: string,
  state: string
): string {
  return sign('handoff', {
    requestId,
    redirectUri,
    state,
    expiresAt: Date.now() + 10 * 60_000,
  });
}

export function readHandoffState(
  value: string
): { requestId: string; redirectUri: string; state: string } | null {
  const payload = verify(value, 'handoff');
  if (
    !payload ||
    typeof payload.requestId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.requestId) ||
    typeof payload.redirectUri !== 'string' ||
    typeof payload.state !== 'string' ||
    typeof payload.expiresAt !== 'number' ||
    payload.expiresAt < Date.now()
  ) {
    return null;
  }
  return {
    requestId: payload.requestId,
    redirectUri: payload.redirectUri,
    state: payload.state,
  };
}
