import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import handler from '../api/index.js';

type JsonObject = Record<string, unknown>;

class FakeResponse {
  statusCode = 200;
  body: JsonObject | undefined;
  location: string | undefined;
  headers = new Map<string, unknown>();

  setHeader(name: string, value: unknown) {
    this.headers.set(name.toLowerCase(), value);
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  json(body: JsonObject) {
    this.body = body;
    return this;
  }

  redirect(code: number, location: string) {
    this.statusCode = code;
    this.location = location;
    return this;
  }

  end() {
    return this;
  }
}

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const HOSTED_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const LOOPBACK_REDIRECT = 'http://127.0.0.1:8765/callback';

const originalGraphqlUrl = process.env.RUNPOD_GRAPHQL_URL;
const originalConsoleBaseUrl = process.env.CONSOLE_BASE_URL;
const originalApiKeyName = process.env.RUNPOD_API_KEY_NAME;

let backend: http.Server;
let backendRequests: string[] = [];
let flashStatus: JsonObject;

before(async () => {
  backend = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
        query: string;
      };
      backendRequests.push(payload.query);
      res.setHeader('content-type', 'application/json');
      if (payload.query.includes('createFlashAuthRequest')) {
        res.end(
          JSON.stringify({ data: { createFlashAuthRequest: { id: 'code-1' } } })
        );
        return;
      }
      res.end(
        JSON.stringify({ data: { flashAuthRequestStatus: flashStatus } })
      );
    });
  });

  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  assert(address && typeof address === 'object');
  process.env.RUNPOD_GRAPHQL_URL = `http://127.0.0.1:${address.port}/graphql`;
  process.env.CONSOLE_BASE_URL = 'https://console.example.test';
  process.env.RUNPOD_API_KEY_NAME = '';
});

beforeEach(() => {
  backendRequests = [];
  flashStatus = {
    id: 'code-1',
    status: 'APPROVED',
    apiKey: 'rp_test_secret',
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
  };
});

after(async () => {
  if (originalGraphqlUrl === undefined) delete process.env.RUNPOD_GRAPHQL_URL;
  else process.env.RUNPOD_GRAPHQL_URL = originalGraphqlUrl;
  if (originalConsoleBaseUrl === undefined) delete process.env.CONSOLE_BASE_URL;
  else process.env.CONSOLE_BASE_URL = originalConsoleBaseUrl;
  if (originalApiKeyName === undefined) delete process.env.RUNPOD_API_KEY_NAME;
  else process.env.RUNPOD_API_KEY_NAME = originalApiKeyName;

  await new Promise<void>((resolve, reject) =>
    backend.close((error) => (error ? reject(error) : resolve()))
  );
});

async function request(method: string, url: string, body?: string) {
  const req = {
    method,
    url,
    body,
    headers: { host: 'mcp.example.test' },
  };
  const res = new FakeResponse();
  await handler(req as never, res as never);
  return res;
}

async function authorize(
  redirectUri: string,
  codeChallenge?: string,
  codeChallengeMethod?: string
) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: 'test-client',
    redirect_uri: redirectUri,
  });
  if (codeChallenge !== undefined) {
    params.set('code_challenge', codeChallenge);
  }
  if (codeChallengeMethod !== undefined) {
    params.set('code_challenge_method', codeChallengeMethod);
  }
  return request('GET', `/authorize?${params.toString()}`);
}

async function token(codeVerifier?: string) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code: 'code-1',
    redirect_uri: HOSTED_REDIRECT,
  });
  if (codeVerifier !== undefined) {
    params.set('code_verifier', codeVerifier);
  }
  return request('POST', '/token', params.toString());
}

describe('OAuth PKCE endpoints', () => {
  it('rejects missing PKCE for both hosted and loopback redirects', async () => {
    for (const redirectUri of [HOSTED_REDIRECT, LOOPBACK_REDIRECT]) {
      const res = await authorize(redirectUri);
      assert.equal(res.statusCode, 400);
      assert.deepEqual(res.body, {
        error: 'invalid_request',
        error_description: 'code_challenge is required.',
      });
    }
    assert.equal(backendRequests.length, 0);
  });

  it('rejects missing, plain, and malformed challenge methods before issuing a code', async () => {
    const missing = await authorize(HOSTED_REDIRECT, CHALLENGE);
    assert.equal(missing.statusCode, 400);

    const plain = await authorize(HOSTED_REDIRECT, VERIFIER, 'plain');
    assert.equal(plain.statusCode, 400);

    const malformed = await authorize(HOSTED_REDIRECT, `${CHALLENGE}=`, 'S256');
    assert.equal(malformed.statusCode, 400);
    assert.equal(backendRequests.length, 0);
  });

  it('persists valid S256 parameters and starts authorization', async () => {
    const res = await authorize(HOSTED_REDIRECT, CHALLENGE, 'S256');
    assert.equal(res.statusCode, 302);
    assert.match(res.location ?? '', /^https:\/\/console\.example\.test\//);
    assert.equal(backendRequests.length, 1);
    assert.match(
      backendRequests[0],
      new RegExp(`codeChallenge: "${CHALLENGE}"`)
    );
    assert.match(backendRequests[0], /codeChallengeMethod: "S256"/);
  });

  it('fails closed when an authorization code has no stored PKCE state', async () => {
    flashStatus.codeChallenge = null;
    flashStatus.codeChallengeMethod = null;

    const res = await token(VERIFIER);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      error: 'invalid_grant',
      error_description:
        'PKCE code_challenge is missing for this authorization code.',
    });
  });

  it('rejects malformed verifiers without reading or consuming the code', async () => {
    const missing = await token();
    assert.equal(missing.statusCode, 400);
    assert.equal(missing.body?.error, 'invalid_grant');
    assert.equal(backendRequests.length, 0);

    const malformed = await token('too-short');
    assert.equal(malformed.statusCode, 400);
    assert.equal(
      malformed.body?.error_description,
      'code_verifier must be 43 to 128 unreserved characters.'
    );
    assert.equal(backendRequests.length, 0);

    const wrong = await token('a'.repeat(43));
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.body?.error_description, 'PKCE verification failed.');
    assert.equal(backendRequests.length, 1);
  });

  it('returns the API key only for a matching verifier', async () => {
    const res = await token(VERIFIER);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, {
      access_token: 'rp_test_secret',
      token_type: 'Bearer',
    });
  });
});
