import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import handler, {
  DEFAULT_FLASH_GRAPHQL_TIMEOUT_MS,
  getFlashTimeoutMs,
} from '../api/index.js';

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
const CODE = 'c'.repeat(64);
const REQUEST_ID = 'd'.repeat(64);
const HOSTED_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_REDIRECT =
  'https://chatgpt.com/connector/oauth/connection_123-ABC';
const OTHER_CHATGPT_REDIRECT =
  'https://chatgpt.com/connector/oauth/another-connection';

const original = {
  graphql: process.env.RUNPOD_GRAPHQL_URL,
  console: process.env.CONSOLE_BASE_URL,
  keyName: process.env.RUNPOD_API_KEY_NAME,
  signingKey: process.env.MCP_OAUTH_SIGNING_KEY,
  timeout: process.env.MCP_FLASH_TIMEOUT_MS,
};
let backend: http.Server;
let backendRequests: string[] = [];
let backendStalls = false;
const stalledResponses: http.ServerResponse[] = [];

before(async () => {
  backend = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
        query: string;
      };
      backendRequests.push(payload.query);
      if (backendStalls) {
        stalledResponses.push(res);
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (payload.query.includes('createFlashAuthRequest')) {
        res.end(
          JSON.stringify({
            data: { createFlashAuthRequest: { id: REQUEST_ID } },
          })
        );
      } else if (payload.query.includes('redeemFlashOAuthCode')) {
        res.end(
          JSON.stringify({
            data: { redeemFlashOAuthCode: { apiKey: 'rp_test_secret' } },
          })
        );
      } else {
        res.end(
          JSON.stringify({
            errors: [{ message: 'unexpected GraphQL operation' }],
          })
        );
      }
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address();
  assert(address && typeof address === 'object');
  process.env.RUNPOD_GRAPHQL_URL = `http://127.0.0.1:${address.port}/graphql`;
  process.env.CONSOLE_BASE_URL = 'https://console.example.test';
  process.env.RUNPOD_API_KEY_NAME = '';
  process.env.MCP_OAUTH_SIGNING_KEY = 'a'.repeat(64);
});

beforeEach(() => {
  backendRequests = [];
  backendStalls = false;
});

after(async () => {
  for (const res of stalledResponses) res.destroy();
  stalledResponses.length = 0;
  for (const [key, value] of Object.entries({
    RUNPOD_GRAPHQL_URL: original.graphql,
    CONSOLE_BASE_URL: original.console,
    RUNPOD_API_KEY_NAME: original.keyName,
    MCP_OAUTH_SIGNING_KEY: original.signingKey,
    MCP_FLASH_TIMEOUT_MS: original.timeout,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve, reject) =>
    backend.close((error) => (error ? reject(error) : resolve()))
  );
});

async function request(method: string, url: string, body?: string) {
  const req = { method, url, body, headers: { host: 'mcp.example.test' } };
  const res = new FakeResponse();
  await handler(req as never, res as never);
  return res;
}

async function register(redirectUris: string[]) {
  return request('POST', '/register', {
    redirect_uris: redirectUris,
    client_name: 'ChatGPT',
  } as never);
}

async function authorize(
  redirectUri: string,
  clientId = 'legacy-client',
  challenge = CHALLENGE
) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'original-state',
  });
  return request('GET', `/authorize?${params.toString()}`);
}

async function token(
  redirectUri: string,
  clientId: string,
  code = CODE,
  verifier = VERIFIER
) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  return request('POST', '/token', params.toString());
}

describe('dynamic ChatGPT registration', () => {
  it('registers each exact callback and uses a distinct signed client ID', async () => {
    const first = await register([CHATGPT_REDIRECT]);
    const second = await register([OTHER_CHATGPT_REDIRECT]);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.notEqual(first.body?.client_id, second.body?.client_id);
    assert.equal(backendRequests.length, 0);

    const clientId = String(first.body?.client_id);
    const accepted = await authorize(CHATGPT_REDIRECT, clientId);
    assert.equal(accepted.statusCode, 302);
    assert.equal(backendRequests.length, 1);
    assert.match(backendRequests[0], /oauthCodeExchange: true/);

    const rejected = await authorize(OTHER_CHATGPT_REDIRECT, clientId);
    assert.equal(rejected.statusCode, 400);
    assert.equal(backendRequests.length, 1);
  });

  it('rejects a forged client ID and lookalike callbacks', async () => {
    const registered = await register([CHATGPT_REDIRECT]);
    const clientId = String(registered.body?.client_id);
    const forged = `${clientId.slice(0, -1)}x`;
    assert.equal((await authorize(CHATGPT_REDIRECT, forged)).statusCode, 400);
    for (const uri of [
      'http://chatgpt.com/connector/oauth/connection_123-ABC',
      'https://chatgpt.com.evil.test/connector/oauth/connection_123-ABC',
      'https://chatgpt.com@evil.test/connector/oauth/connection_123-ABC',
      `${CHATGPT_REDIRECT}?next=https://evil.test`,
      `${CHATGPT_REDIRECT}/extra`,
    ]) {
      assert.equal((await register([uri])).statusCode, 400, uri);
    }
    assert.equal(backendRequests.length, 0);
  });

  it('returns through a fixed console callback, then forwards to registered ChatGPT URI', async () => {
    const registered = await register([CHATGPT_REDIRECT]);
    const auth = await authorize(
      CHATGPT_REDIRECT,
      String(registered.body?.client_id)
    );
    assert.equal(auth.statusCode, 302);
    const handoff = new URL(auth.location!);
    const inner = new URL(
      decodeURIComponent(handoff.searchParams.get('redirect')!),
      'https://console.example.test'
    );
    assert.equal(
      inner.searchParams.get('redirect_uri'),
      'https://mcp.getrunpod.io/oauth/complete'
    );
    const state = inner.searchParams.get('state');
    assert.ok(state);
    assert.equal(inner.searchParams.get('request'), REQUEST_ID);
    const verified = await request(
      'GET',
      `/oauth/handoff?${new URLSearchParams({ request: REQUEST_ID, state }).toString()}`
    );
    assert.equal(verified.statusCode, 200);
    assert.equal(verified.body?.redirect_uri, CHATGPT_REDIRECT);
    assert.equal(
      (
        await request(
          'GET',
          `/oauth/handoff?${new URLSearchParams({ request: 'e'.repeat(64), state }).toString()}`
        )
      ).statusCode,
      400
    );

    const complete = await request(
      'GET',
      `/oauth/complete?${new URLSearchParams({ code: CODE, state, request: REQUEST_ID }).toString()}`
    );
    assert.equal(complete.statusCode, 302);
    assert.equal(
      complete.location,
      `${CHATGPT_REDIRECT}?code=${CODE}&state=original-state`
    );
    assert.equal(
      (await request('GET', `/oauth/complete?code=${CODE}&state=forged`))
        .statusCode,
      400
    );
    assert.equal(
      (
        await request(
          'GET',
          `/oauth/complete?${new URLSearchParams({ code: CODE, state, request: 'e'.repeat(64) }).toString()}`
        )
      ).statusCode,
      400
    );
  });

  it('redeems only for the registered callback and a syntactically valid verifier', async () => {
    const registered = await register([CHATGPT_REDIRECT]);
    const clientId = String(registered.body?.client_id);
    assert.equal(
      (await token(OTHER_CHATGPT_REDIRECT, clientId)).statusCode,
      400
    );
    assert.equal(
      (await token(CHATGPT_REDIRECT, clientId, CODE, 'short')).statusCode,
      400
    );
    assert.equal(backendRequests.length, 0);
    const result = await token(CHATGPT_REDIRECT, clientId);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body?.access_token, 'rp_test_secret');
    assert.equal(backendRequests.length, 1);
    assert.match(backendRequests[0], /redeemFlashOAuthCode/);
  });
});

describe('existing OAuth clients', () => {
  it('keeps an exact hosted callback available and requires S256 PKCE', async () => {
    const accepted = await authorize(HOSTED_REDIRECT);
    assert.equal(accepted.statusCode, 302);
    assert.equal(backendRequests.length, 1);
    const missing = await authorize(HOSTED_REDIRECT, 'legacy-client', '');
    assert.equal(missing.statusCode, 400);
    const wrongHost = await authorize(
      'https://claude.ai.evil.test/api/mcp/auth_callback'
    );
    assert.equal(wrongHost.statusCode, 400);
  });

  it('bounds a stalled backend call', { timeout: 10_000 }, async () => {
    backendStalls = true;
    process.env.MCP_FLASH_TIMEOUT_MS = '150';
    try {
      const started = Date.now();
      const result = await token(HOSTED_REDIRECT, 'legacy-client');
      assert.equal(result.statusCode, 400);
      assert.ok(Date.now() - started < 5_000);
      assert.equal(backendRequests.length, 1);
    } finally {
      delete process.env.MCP_FLASH_TIMEOUT_MS;
    }
  });

  it('ignores invalid MCP_FLASH_TIMEOUT_MS values', () => {
    for (const bad of [
      'abc',
      '0',
      '-1',
      'NaN',
      'Infinity',
      '10000.5',
      '5000000000',
    ]) {
      process.env.MCP_FLASH_TIMEOUT_MS = bad;
      assert.equal(getFlashTimeoutMs(), DEFAULT_FLASH_GRAPHQL_TIMEOUT_MS);
    }
    process.env.MCP_FLASH_TIMEOUT_MS = '250';
    assert.equal(getFlashTimeoutMs(), 250);
    delete process.env.MCP_FLASH_TIMEOUT_MS;
  });
});
