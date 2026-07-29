import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * True for a loopback host (localhost / 127.0.0.1 / ::1), ignoring IPv6 brackets.
 * Loopback is the native-app redirect case that PKCE (RFC 7636) is designed for.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

type PkceAuthorizationResult =
  | { ok: true; codeChallenge: string }
  | { ok: false; error: string };

type PkceVerifierResult =
  | { ok: true; codeVerifier: string }
  | { ok: false; error: string };

/**
 * S256 transform: base64url(SHA-256(verifier)), unpadded — RFC 7636 §4.2.
 */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Constant-time string compare. Returns false immediately on a length mismatch
 * (timingSafeEqual throws on unequal-length buffers), else compares without an
 * early-exit that could leak how many leading chars matched.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Validate PKCE parameters before issuing an authorization code. This server
 * advertises only S256 and requires it for every hosted OAuth flow.
 */
export function validatePkceAuthorization(input: {
  codeChallenge?: string | null;
  codeChallengeMethod?: string | null;
}): PkceAuthorizationResult {
  const { codeChallenge, codeChallengeMethod } = input;

  if (!codeChallenge) {
    return { ok: false, error: 'code_challenge is required.' };
  }
  if (codeChallengeMethod !== 'S256') {
    return { ok: false, error: 'code_challenge_method must be S256.' };
  }
  if (!S256_CHALLENGE.test(codeChallenge)) {
    return {
      ok: false,
      error: 'code_challenge must be a 43-character base64url S256 value.',
    };
  }
  return { ok: true, codeChallenge };
}

/** Validate the client-owned verifier before reading or consuming a code. */
export function validatePkceVerifier(
  codeVerifier?: string | null
): PkceVerifierResult {
  if (!codeVerifier) {
    return { ok: false, error: 'code_verifier is required.' };
  }
  if (!CODE_VERIFIER.test(codeVerifier)) {
    return {
      ok: false,
      error: 'code_verifier must be 43 to 128 unreserved characters.',
    };
  }
  return { ok: true, codeVerifier };
}

/**
 * Verify a PKCE (RFC 7636) code_verifier against the code_challenge stored on the
 * flash auth request. Returns null when the token exchange may proceed, or an
 * OAuth error_description string when it must be rejected (invalid_grant).
 *
 * Policy:
 * - Every authorization code must have a valid S256 challenge and method.
 * - A code_verifier is mandatory, must follow RFC 7636 syntax, and must match.
 */
export function verifyPkce(input: {
  codeChallenge?: string | null;
  codeChallengeMethod?: string | null;
  codeVerifier?: string | null;
}): string | null {
  const { codeChallenge, codeChallengeMethod, codeVerifier } = input;

  if (!codeChallenge) {
    return 'PKCE code_challenge is missing for this authorization code.';
  }
  if (codeChallengeMethod !== 'S256') {
    return 'Stored code_challenge_method must be S256.';
  }
  if (!S256_CHALLENGE.test(codeChallenge)) {
    return 'Stored code_challenge is not a valid S256 value.';
  }
  const verifier = validatePkceVerifier(codeVerifier);
  if (!verifier.ok) return verifier.error;

  if (!safeEqual(s256(verifier.codeVerifier), codeChallenge)) {
    return 'PKCE verification failed.';
  }
  return null;
}
