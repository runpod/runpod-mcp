/**
 * End-to-end OAuth debug harness for the hosted MCP server.
 *
 * Runs the full "Sign in with Runpod" flow a real client (Claude) would:
 *   discovery -> dynamic client registration -> /authorize -> approve ->
 *   /token -> connect to the MCP with the minted key -> call a tool.
 *
 * The ONLY step that needs a Runpod user is the approval. Two modes:
 *   - RUNPOD_DEV_API_KEY set  -> auto-approves via approveFlashAuthRequest (fully headless)
 *   - not set                 -> prints the console URL and polls until you approve in a browser
 *
 * Env:
 *   MCP_SERVER_URL       hosted MCP base URL (required)
 *   RUNPOD_GRAPHQL_URL   flash backend (default https://api.runpod.dev/graphql)
 *   RUNPOD_DEV_API_KEY   optional dev key to auto-approve
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const MCP = process.env.MCP_SERVER_URL;
const GQL = process.env.RUNPOD_GRAPHQL_URL ?? 'https://api.runpod.dev/graphql';
const DEV_KEY = process.env.RUNPOD_DEV_API_KEY;

if (!MCP) throw new Error('MCP_SERVER_URL is required');
const base = MCP.replace(/\/$/, '');

function log(step: string, data: unknown) {
  console.log(`\n[${step}]`, JSON.stringify(data, null, 2));
}

async function gql<T>(query: string, authToken?: string): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetch(GQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let json: { data?: T; errors?: Array<{ message: string }> };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `GraphQL non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`
    );
  }
  if (json.errors?.length)
    throw new Error(json.errors.map((e) => e.message).join(', '));
  if (!json.data) throw new Error('GraphQL returned no data');
  return json.data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
        redirect_uris: ['https://example.com/cb'],
        grant_types: ['authorization_code'],
      }),
    })
  ).json();
  log('register', { client_id: reg.client_id });

  // 3. /authorize -> capture console handoff + flash request id (= the OAuth code)
  const authRes = await fetch(
    `${base}/authorize?client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(
      'https://example.com/cb'
    )}&state=e2e&code_challenge=x&code_challenge_method=S256&response_type=code`,
    { redirect: 'manual' }
  );
  const location = authRes.headers.get('location') ?? '';
  const inner = new URL(
    decodeURIComponent(new URL(location).searchParams.get('redirect')!),
    'http://x'
  );
  const code = inner.searchParams.get('request')!;
  log('authorize', { status: authRes.status, code, consoleUrl: location });

  // 4. Approve
  if (DEV_KEY) {
    const approved = await gql<{ approveFlashAuthRequest: { status: string } }>(
      `mutation { approveFlashAuthRequest(flashAuthRequestId: ${JSON.stringify(
        code
      )}) { id status } }`,
      DEV_KEY
    );
    log('approve (auto, dev key)', approved.approveFlashAuthRequest);
  } else {
    console.log(
      '\n[approve] No RUNPOD_DEV_API_KEY. Open and approve:\n' + location
    );
    process.stdout.write('[approve] polling status');
    for (let i = 0; i < 60; i++) {
      const s = await gql<{ flashAuthRequestStatus: { status: string } }>(
        `query { flashAuthRequestStatus(flashAuthRequestId: ${JSON.stringify(code)}) { status } }`
      );
      const st = s.flashAuthRequestStatus.status;
      if (st === 'APPROVED') break;
      if (st === 'DENIED' || st === 'EXPIRED') throw new Error(`request ${st}`);
      process.stdout.write('.');
      await sleep(3000);
    }
    console.log('');
  }

  // 5. /token -> minted Runpod API key as access_token
  const tokenRes = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://example.com/cb',
      code_verifier: 'x',
    }).toString(),
  });
  const token = await tokenRes.json();
  if (!token.access_token)
    throw new Error(`token exchange failed: ${JSON.stringify(token)}`);
  const key = token.access_token as string;
  log('token', {
    token_type: token.token_type,
    access_token: `${key.slice(0, 6)}...${key.slice(-4)}`,
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
  console.log('\n✅ full chain OK');
}

main().catch((e) => {
  console.error('\n❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
