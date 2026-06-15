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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP = process.env.MCP_SERVER_URL;
if (!MCP) throw new Error('MCP_SERVER_URL is required');
const base = MCP.replace(/\/$/, '');

function log(step: string, data: unknown) {
  console.log(`\n[${step}]`, JSON.stringify(data, null, 2));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST the token endpoint once. Returns the parsed JSON body + HTTP status.
 *
 * PKCE test: we sent `code_challenge=challenge-abc` at /authorize but send a
 * deliberately NON-matching `code_verifier` here. If the token is still minted,
 * the server is not enforcing PKCE (S256 would require the verifier to hash to
 * the challenge).
 */
async function postToken(code: string) {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'http://localhost:8765/callback',
      code_verifier: 'this-verifier-does-not-match-the-challenge',
    }).toString(),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
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

  // 3. /authorize -> capture console handoff + flash request id (= the OAuth code)
  const authRes = await fetch(
    `${base}/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(
      'http://localhost:8765/callback'
    )}&state=e2e&code_challenge=challenge-abc&code_challenge_method=S256&response_type=code`,
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

  // 4. Approve (manual) + 5. poll /token for the minted key. We only call the
  // MCP's own token endpoint — it polls the backend server-side and returns the
  // minted key once the request is APPROVED.
  console.log('\n[approve] Open and approve in your browser:\n' + location);
  process.stdout.write('[token] polling');
  let key: string | undefined;
  for (let i = 0; i < 30; i++) {
    const { body } = await postToken(code);
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

  // 6. Connect to the MCP with the minted key and call a tool
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
