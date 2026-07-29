import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  s256,
  validatePkceAuthorization,
  validatePkceVerifier,
  verifyPkce,
} from '../src/oauth/pkce.js';

// RFC 7636 Appendix B canonical test vector.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function authorizationError(
  input: Parameters<typeof validatePkceAuthorization>[0]
): string | null {
  const result = validatePkceAuthorization(input);
  return result.ok ? null : result.error;
}

describe('s256', () => {
  it('reproduces the RFC 7636 Appendix B vector (unpadded base64url)', () => {
    assert.equal(s256(VERIFIER), CHALLENGE);
  });
});

describe('validatePkceAuthorization', () => {
  it('accepts a valid S256 challenge', () => {
    assert.deepEqual(
      validatePkceAuthorization({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
      }),
      { ok: true, codeChallenge: CHALLENGE }
    );
  });

  it('rejects a missing challenge', () => {
    assert.equal(
      authorizationError({
        codeChallenge: null,
        codeChallengeMethod: null,
      }),
      'code_challenge is required.'
    );
  });

  it('rejects a missing method instead of treating it as S256', () => {
    assert.equal(
      authorizationError({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: null,
      }),
      'code_challenge_method must be S256.'
    );
  });

  it('rejects plain', () => {
    assert.equal(
      authorizationError({
        codeChallenge: VERIFIER,
        codeChallengeMethod: 'plain',
      }),
      'code_challenge_method must be S256.'
    );
  });

  it('rejects a malformed S256 challenge', () => {
    assert.equal(
      authorizationError({
        codeChallenge: `${CHALLENGE}=`,
        codeChallengeMethod: 'S256',
      }),
      'code_challenge must be a 43-character base64url S256 value.'
    );
  });
});

describe('validatePkceVerifier', () => {
  it('returns a normalized valid verifier', () => {
    assert.deepEqual(validatePkceVerifier(VERIFIER), {
      ok: true,
      codeVerifier: VERIFIER,
    });
  });

  it('rejects missing and malformed verifiers', () => {
    assert.deepEqual(validatePkceVerifier(null), {
      ok: false,
      error: 'code_verifier is required.',
    });
    assert.deepEqual(validatePkceVerifier('too-short'), {
      ok: false,
      error: 'code_verifier must be 43 to 128 unreserved characters.',
    });
  });
});

describe('verifyPkce', () => {
  it('passes for a correct verifier (S256)', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        codeVerifier: VERIFIER,
      }),
      null
    );
  });

  it('rejects a wrong verifier', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        codeVerifier: 'a'.repeat(43),
      }),
      'PKCE verification failed.'
    );
  });

  it('rejects a missing verifier when a challenge was stored', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        codeVerifier: null,
      }),
      'code_verifier is required.'
    );
  });

  it('rejects a malformed verifier', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        codeVerifier: 'too-short',
      }),
      'code_verifier must be 43 to 128 unreserved characters.'
    );
  });

  it('rejects an authorization code with no stored challenge', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: null,
        codeChallengeMethod: 'S256',
        codeVerifier: VERIFIER,
      }),
      'PKCE code_challenge is missing for this authorization code.'
    );
  });

  it('rejects a missing or non-S256 stored method', () => {
    for (const codeChallengeMethod of [null, 'plain']) {
      assert.equal(
        verifyPkce({
          codeChallenge: CHALLENGE,
          codeChallengeMethod,
          codeVerifier: VERIFIER,
        }),
        'Stored code_challenge_method must be S256.'
      );
    }
  });

  it('rejects a malformed stored challenge', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: `${CHALLENGE}=`,
        codeChallengeMethod: 'S256',
        codeVerifier: VERIFIER,
      }),
      'Stored code_challenge is not a valid S256 value.'
    );
  });
});
