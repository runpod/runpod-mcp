// ============== LIVE CRUD SMOKE (dev account) — B6 ==============
// Boots the stdio MCP server once per requested REST version, runs a real
// create → get → delete lifecycle against the dev account, and tears down
// everything it created. Teardown is part of the test: every created resource is
// tracked by NAME and deleted in a `finally`, and a fail-closed post-verify asserts
// no `mcp-smoke-*` resources remain (exit non-zero on any leak).
//
// Uses only FREE resources (templates, container-registry-auth) — no pods or
// network volumes, so it can't incur GPU/storage cost. Not part of `pnpm test`
// (it hits the live API and needs RUNPOD_API_KEY). Run manually:
//   RUNPOD_API_KEY=... RUNPOD_REST_V2_API_URL=https://v2-rest.runpod.dev/v2 \
//     tsx scripts/smoke-crud.ts v1 v2
//
// A unique run prefix keeps test resources identifiable and collision-free; a
// pre-sweep at start removes orphans from a prior crashed run.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';

const PREFIX = 'mcp-smoke';
const runId = `${PREFIX}-${randomUUID().slice(0, 8)}`;

function apiKey(): string {
  const k = process.env.RUNPOD_API_KEY;
  if (!k) throw new Error('RUNPOD_API_KEY is required');
  return k;
}

async function connect(version: string): Promise<Client> {
  // StdioClientTransport REPLACES (does not merge) the child env, so without an
  // explicit passthrough the child boots with prod defaults and a caller-set
  // RUNPOD_REST_V2_API_URL (e.g. the dev host) silently never reaches it —
  // making the "v2" smoke actually validate against prod. Forward the relevant
  // overrides, but keep RUNPOD_REST_VERSION authoritative to THIS run's `version`
  // (don't let a parent RUNPOD_REST_VERSION override the per-version loop).
  const childEnv: Record<string, string> = {
    RUNPOD_API_KEY: apiKey(),
    RUNPOD_REST_VERSION: version,
  };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key === 'RUNPOD_REST_VERSION') continue;
    if (
      key.startsWith('RUNPOD_REST') ||
      key === 'RUNPOD_SERVERLESS_API_URL' ||
      key === 'RUNPOD_PUBLIC_GRAPHQL_URL'
    ) {
      childEnv[key] = value;
    }
  }
  const transport = new StdioClientTransport({
    command: 'node',
    args: [process.env.SMOKE_SERVER ?? 'dist/stdio.mjs'],
    env: childEnv,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'smoke-crud', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function parse(result: unknown): unknown {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  const text = r?.content?.find((c) => c.type === 'text')?.text;
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
) {
  return parse(await client.callTool({ name, arguments: args }));
}

// List a tool's FULL result, paging through the MCP cap envelope until
// `truncated` is false. Critical for leak detection: the list tools cap at 20
// items by default, so a single capped page would hide a leak (or orphan) that
// sits beyond index 20 on a busy dev account. Throws if a page errors — the
// caller treats that as fail-closed (a verify we can't complete is a failure,
// never a silent "clean").
async function listAll(
  client: Client,
  tool: string
): Promise<Array<Record<string, unknown>>> {
  const all: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  for (;;) {
    const args: Record<string, unknown> = { limit: 100 };
    if (cursor) args.cursor = cursor;
    const payload = await call(client, tool, args);
    if (payload == null || typeof payload === 'string') {
      throw new Error(`${tool} returned no parseable list payload`);
    }
    if (Array.isArray(payload)) {
      all.push(...(payload as Array<Record<string, unknown>>));
      break; // bare array (uncapped) — nothing more to page
    }
    const env = payload as {
      items?: unknown[];
      pagination?: { truncated?: boolean; nextCursor?: string | null };
    };
    if (!Array.isArray(env.items)) {
      throw new Error(`${tool} payload missing items[]`);
    }
    all.push(...(env.items as Array<Record<string, unknown>>));
    if (env.pagination?.truncated && env.pagination.nextCursor) {
      cursor = env.pagination.nextCursor;
      continue;
    }
    break;
  }
  return all;
}

function idOf(obj: unknown): string | undefined {
  const o = obj as { id?: string } | null;
  return o?.id;
}

// Delete every PREFIX-named resource a list tool returns, passing each id to the
// delete tool under the given arg name. One helper for both resource kinds —
// they differ only in the list/delete tool names and the delete arg key.
async function sweepByPrefix(
  client: Client,
  listTool: string,
  deleteTool: string,
  idArg: string
): Promise<void> {
  const items = await listAll(client, listTool);
  for (const item of items) {
    if (typeof item.name === 'string' && item.name.startsWith(PREFIX) && item.id) {
      await call(client, deleteTool, { [idArg]: item.id });
    }
  }
}

async function runVersion(version: string): Promise<void> {
  console.error(`\n=== CRUD smoke: RUNPOD_REST_VERSION=${version} ===`);
  const client = await connect(version);
  const createdRegistry: string[] = [];
  const createdTemplate: string[] = [];

  try {
    // Pre-sweep orphans from a prior crashed run.
    await sweepByPrefix(
      client,
      'list-container-registry-auths',
      'delete-container-registry-auth',
      'containerRegistryAuthId'
    );
    await sweepByPrefix(client, 'list-templates', 'delete-template', 'templateId');

    // --- container registry auth: create → delete ---
    const reg = await call(client, 'create-container-registry-auth', {
      name: `${runId}-reg`,
      username: 'smoke',
      password: 'smoke-pass',
    });
    const regId = idOf(reg);
    if (!regId)
      throw new Error(`registry create returned no id: ${JSON.stringify(reg)}`);
    createdRegistry.push(regId);
    console.error(`  ✓ created registry ${regId}`);

    // --- template: create → get → delete ---
    const tpl = await call(client, 'create-template', {
      name: `${runId}-tpl`,
      imageName: 'runpod/pytorch:1.0.2',
      isServerless: false,
      containerDiskInGb: 10,
    });
    const tplId = idOf(tpl);
    if (!tplId)
      throw new Error(`template create returned no id: ${JSON.stringify(tpl)}`);
    createdTemplate.push(tplId);
    console.error(`  ✓ created template ${tplId}`);

    const got = await call(client, 'get-template', { templateId: tplId });
    if (idOf(got) !== tplId)
      throw new Error('get-template did not round-trip the id');
    console.error('  ✓ get-template round-trip ok');
  } finally {
    // Teardown — best-effort, never let one failure strand the rest.
    for (const id of createdTemplate) {
      try {
        await call(client, 'delete-template', { templateId: id });
      } catch (e) {
        console.error(`  ! template ${id} delete failed: ${String(e)}`);
      }
    }
    for (const id of createdRegistry) {
      try {
        await call(client, 'delete-container-registry-auth', {
          containerRegistryAuthId: id,
        });
      } catch (e) {
        console.error(`  ! registry ${id} delete failed: ${String(e)}`);
      }
    }

    // Fail-closed post-verify: listAll pages the full list and THROWS if any
    // page errors (an unverifiable list is a failure, not a silent "clean").
    let leaked: Array<Record<string, unknown>> = [];
    let verifyError: unknown;
    try {
      const regItems = await listAll(client, 'list-container-registry-auths');
      const tplItems = await listAll(client, 'list-templates');
      leaked = [...regItems, ...tplItems].filter(
        (x) =>
          typeof x.name === 'string' && (x.name as string).startsWith(runId)
      );
    } catch (e) {
      verifyError = e;
    }

    // Always close the transport, regardless of verify outcome.
    try {
      await client.close();
    } catch {
      /* ignore close errors */
    }

    if (verifyError) {
      throw new Error(`post-verify could not complete: ${String(verifyError)}`);
    }
    if (leaked.length > 0) {
      throw new Error(
        `LEAK: ${leaked.length} ${runId}-* resource(s) remain after teardown`
      );
    }
    console.error('  ✓ teardown verified clean');
  }
}

async function main(): Promise<void> {
  // Reject unknown args rather than silently dropping them — a typo like `V2`
  // or `v2 ` must NOT exit 0 having run only the default (false green on a
  // gating script).
  const args = process.argv.slice(2);
  const bad = args.filter((v) => v !== 'v1' && v !== 'v2');
  if (bad.length) {
    console.error(`Unknown version arg(s): ${bad.join(', ')} (expected v1|v2)`);
    process.exit(1);
  }
  const versions = args.length ? args : ['v1'];
  for (const v of versions) {
    await runVersion(v);
  }
  console.error('\nAll CRUD smokes passed.');
}

main().catch((error) => {
  console.error('CRUD smoke FAILED:', error);
  process.exit(1);
});
