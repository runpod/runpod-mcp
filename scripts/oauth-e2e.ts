/**
 * End-to-end OAuth debug harness for the hosted MCP server.
 *
 * Acts as a faithful MCP OAuth client (like Claude) — it only ever talks to the
 * MCP deployment, never to the backend directly:
 *   discovery -> dynamic client registration -> /authorize -> (you approve in a
 *   browser) -> poll /token for the minted key -> connect to the MCP with that
 *   key -> call a tool.
 *
 * The only manual step is approving in the console (it requires a logged-in
 * Runpod user). Whatever backend/stage the deployment is configured for is the
 * one that mints the key — the harness needs no backend URL or credential.
 *
 * Env:
 *   MCP_SERVER_URL   hosted MCP base URL (required)
 */
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { s256 } from '../src/oauth/pkce.js';

const MCP = process.env.MCP_SERVER_URL;
if (!MCP) throw new Error('MCP_SERVER_URL is required');
const base = MCP.replace(/\/$/, '');

// Real PKCE pair for this run: a random verifier and its S256 challenge. The
// happy path sends the matching verifier at /token; the negative check below
// sends a non-matching one and expects `invalid_grant`.
const codeVerifier = randomBytes(32).toString('base64url');
const codeChallenge = s256(codeVerifier);

function log(step: string, data: unknown) {
  console.log(`\n[${step}]`, JSON.stringify(data, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST the token endpoint once with the given `code_verifier`. Returns the
 * parsed JSON body + HTTP status.
 */
async function postToken(code: string, verifier: string) {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:8765/callback',
      code_verifier: verifier,
    }).toString(),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function expectAuthorizeRejected(
  clientId: string,
  label: string,
  pkce: Record<string, string>
) {
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'http://localhost:8765/callback',
    response_type: 'code',
    ...pkce,
  }).toString();
  const res = await fetch(url, { redirect: 'manual' });
  const body = (await res.json()) as Record<string, unknown>;
  if (res.status !== 400 || body.error !== 'invalid_request') {
    throw new Error(
      `${label}: expected 400 invalid_request, got ${res.status} ${JSON.stringify(body)}`
    );
  }
  log(label, { status: res.status, error: body.error });
}

async function main() {
  // 1. Discovery
  const asMeta = await (
    await fetch(`${base}/.well-known/oauth-authorization-server`)
  ).json();
  log('discovery', asMeta);

  // 2. Dynamic client registration
  const reg = await (
    await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'oauth-e2e-debug',
        redirect_uris: ['http://localhost:8765/callback'],
        grant_types: ['authorization_code'],
      }),
    })
  ).json();
  log('register', { client_id: reg.client_id });

  // 3. Invalid authorization requests must fail before a flash request/code is
  // created. This proves there is no hosted or loopback non-PKCE fallback.
  await expectAuthorizeRejected(reg.client_id, 'pkce-required', {});
  await expectAuthorizeRejected(reg.client_id, 'pkce-method-required', {
    code_challenge: codeChallenge,
  });
  await expectAuthorizeRejected(reg.client_id, 'pkce-plain-rejected', {
    code_challenge: codeChallenge,
    code_challenge_method: 'plain',
  });

  // 4. Valid /authorize -> capture console handoff + flash request id (= code)
  const authRes = await fetch(
    `${base}/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(
      'http://localhost:8765/callback'
    )}&state=e2e&code_challenge=${codeChallenge}&code_challenge_method=S256&response_type=code`,
    { redirect: 'manual' }
  );
  const location = authRes.headers.get('location') ?? '';
  // `searchParams.get` already decodes the value once — no second decode needed.
  const inner = new URL(
    new URL(location).searchParams.get('redirect')!,
    'http://x'
  );
  const code = inner.searchParams.get('request')!;
  log('authorize', { status: authRes.status, code, consoleUrl: location });

  // 5. PKCE enforcement check — a non-matching verifier must be rejected with
  // `invalid_grant`, and the rejection happens before approval (the verifier is
  // checked on every /token poll). If this mints or pends, PKCE isn't enforced.
  const bad = await postToken(code, 'a'.repeat(43));
  if (bad.body.error !== 'invalid_grant') {
    throw new Error(
      `PKCE not enforced: bad verifier expected invalid_grant, got ${JSON.stringify(bad.body)}`
    );
  }
  log('pkce-enforced', { status: bad.status, error: bad.body.error });

  // 6. Approve (manual) + 7. poll /token with the MATCHING verifier for the
  // minted key. We only call the MCP's own token endpoint — it polls the backend
  // server-side and returns the minted key once the request is APPROVED.
  console.log('\n[approve] Open and approve in your browser:\n' + location);
  process.stdout.write('[token] polling');
  let key: string | undefined;
  for (let i = 0; i < 30; i++) {
    const { body } = await postToken(code, codeVerifier);
    if (typeof body.access_token === 'string') {
      key = body.access_token;
      break;
    }
    if (body.error && body.error !== 'authorization_pending') {
      throw new Error(`token exchange failed: ${JSON.stringify(body)}`);
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  console.log('');
  if (!key) throw new Error('timed out waiting for approval');
  log('token', {
    token_type: 'Bearer',
    access_token: `${key.slice(0, 6)}...${key.slice(-4)}`,
    note: 'minted Runpod API key — check the dashboard for its name',
  });

  // 8. Connect to the MCP with the minted key and call a tool
  const client = new Client({ name: 'oauth-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  const tools = await client.listTools();
  const pods = await client.callTool({ name: 'list-pods', arguments: {} });
  const text = (pods.content as Array<{ type: string; text?: string }>).find(
    (c) => c.type === 'text'
  )?.text;
  let podSummary: unknown = text;
  try {
    const parsed = JSON.parse(text ?? 'null');
    podSummary = Array.isArray(parsed)
      ? {
          podCount: parsed.length,
          names: parsed.slice(0, 3).map((p) => p.name),
        }
      : parsed;
  } catch {
    /* tool returned a non-JSON error string */
  }
  log('mcp', { toolCount: tools.tools.length, listPods: podSummary });
  await client.close();
  console.log('\n✅ token minted + MCP connected');
}

main().catch((e) => {
  console.error('\n❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
