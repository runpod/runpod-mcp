import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { s256, verifyPkce } from '../src/oauth/pkce.js';

// RFC 7636 Appendix B canonical test vector.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const HOSTED = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK = 'http://127.0.0.1:53219/callback';

describe('s256', () => {
  it('reproduces the RFC 7636 Appendix B vector (unpadded base64url)', () => {
    assert.equal(s256(VERIFIER), CHALLENGE);
  });
});

describe('verifyPkce', () => {
  it('passes for a correct verifier (S256)', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        codeVerifier: VERIFIER,
        redirectUri: HOSTED,
      }),
      null
    );
  });

  it('rejects a wrong verifier', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        codeVerifier: 'not-the-verifier',
        redirectUri: HOSTED,
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
        redirectUri: HOSTED,
      }),
      'code_verifier is required.'
    );
  });

  it('rejects the plain method (we advertise only S256)', () => {
    const err = verifyPkce({
      codeChallenge: VERIFIER, // plain challenge == verifier
      codeChallengeMethod: 'plain',
      codeVerifier: VERIFIER,
      redirectUri: HOSTED,
    });
    assert.match(String(err), /only S256 is supported/);
  });

  it('allows a hosted exact-match redirect with no challenge (legacy flow)', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: null,
        codeChallengeMethod: null,
        codeVerifier: null,
        redirectUri: HOSTED,
      }),
      null
    );
  });

  it('requires PKCE for a loopback redirect with no challenge', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: null,
        codeChallengeMethod: null,
        codeVerifier: null,
        redirectUri: LOOPBACK,
      }),
      'PKCE is required for loopback redirect URIs.'
    );
  });

  it('passes a loopback redirect when PKCE is present and correct', () => {
    assert.equal(
      verifyPkce({
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        codeVerifier: VERIFIER,
        redirectUri: LOOPBACK,
      }),
      null
    );
  });
});
