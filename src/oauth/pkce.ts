import { createHash } from 'node:crypto';

/**
 * True for a loopback host (localhost / 127.0.0.1 / ::1), ignoring IPv6 brackets.
 * Loopback is the native-app redirect case that PKCE (RFC 7636) is designed for.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** True when `redirectUri` parses and points at a loopback host. */
export function isLoopbackRedirect(redirectUri: string | null): boolean {
  if (!redirectUri) return false;
  try {
    return isLoopbackHost(new URL(redirectUri).hostname);
  } catch {
    return false;
  }
}

/**
 * S256 transform: base64url(SHA-256(verifier)), unpadded — RFC 7636 §4.2.
 */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Verify a PKCE (RFC 7636) code_verifier against the code_challenge stored on the
 * flash auth request. Returns null when the token exchange may proceed, or an
 * OAuth error_description string when it must be rejected (invalid_grant).
 *
 * Policy:
 * - We advertise only S256, so a stored non-S256 method (e.g. `plain`) is rejected.
 * - When a challenge was stored, a code_verifier is mandatory and must match.
 * - Loopback redirect URIs (native apps — the interception case PKCE is designed
 *   for) MUST use PKCE; a loopback flow with no stored challenge is rejected.
 *   Hosted exact-match redirects may still use the legacy non-PKCE flow.
 */
export function verifyPkce(input: {
  codeChallenge?: string | null;
  codeChallengeMethod?: string | null;
  codeVerifier?: string | null;
  redirectUri: string | null;
}): string | null {
  const { codeChallenge, codeChallengeMethod, codeVerifier, redirectUri } = input;

  if (!codeChallenge) {
    if (isLoopbackRedirect(redirectUri)) {
      return 'PKCE is required for loopback redirect URIs.';
    }
    return null; // legacy hosted (exact-match) flow, no PKCE
  }

  if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
    return `Unsupported code_challenge_method '${codeChallengeMethod}'; only S256 is supported.`;
  }
  if (!codeVerifier) {
    return 'code_verifier is required.';
  }
  if (s256(codeVerifier) !== codeChallenge) {
    return 'PKCE verification failed.';
  }
  return null;
}
