// ============== LIVE CRUD SMOKE (dev account) — B6 ==============
// Boots the stdio MCP server, runs a real
// create → get → delete lifecycle against the dev account, and tears down
// everything it created. Teardown is part of the test: every created resource is
// tracked by NAME and deleted in a `finally`, and a fail-closed post-verify asserts
// no `mcp-smoke-*` resources remain (exit non-zero on any leak).
//
// Uses only FREE resources (templates, registries) — no pods or
// network volumes, so it can't incur GPU/storage cost. Not part of `pnpm test`
// (it hits the live API and needs RUNPOD_API_KEY). Run manually:
//   RUNPOD_API_KEY=... pnpm smoke:crud
//
// A unique run prefix keeps test resources identifiable and collision-free; a
// pre-sweep at start removes orphans from a prior crashed run.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { randomUUID } from 'node:crypto';

const ENV_PASSTHROUGH = [
  'RUNPOD_API_BASE_URL',
  'RUNPOD_SERVERLESS_API_URL',
  'RUNPOD_PUBLIC_GRAPHQL_URL',
  'RUNPOD_AUTHED_GRAPHQL_URL',
];

const PREFIX = 'mcp-smoke';
const runId = `${PREFIX}-${randomUUID().slice(0, 8)}`;

function apiKey(): string {
  const k = process.env.RUNPOD_API_KEY;
  if (!k) throw new Error('RUNPOD_API_KEY is required');
  return k;
}

async function connect(): Promise<Client> {
  // StdioClientTransport REPLACES (does not merge) the child env, so without an
  // explicit passthrough the child boots with prod defaults and a caller-set
  // host override (e.g. the dev API) silently never reaches it. Forward the
  // relevant overrides.
  const childEnv: Record<string, string> = {
    RUNPOD_API_KEY: apiKey(),
  };
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
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
  // The server reports tool failures as successful protocol results with
  // isError: true — callTool does not throw on those. Without this check a
  // failing delete "succeeds" silently and the teardown guarantee is fiction.
  const result = await client.callTool({ name, arguments: args });
  const parsed = parse(result);
  if ((result as { isError?: boolean }).isError) {
    throw new Error(`${name} failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
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
    // Curated lists return { items, pagination }; generated lists return the
    // raw v2 payload keyed by resource ({ registries: [...] }, { templates: [...] }).
    const list =
      env.items ??
      Object.values(payload as Record<string, unknown>).find(Array.isArray);
    if (!Array.isArray(list)) {
      throw new Error(`${tool} payload contained no list`);
    }
    all.push(...(list as Array<Record<string, unknown>>));
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

async function runSmoke(): Promise<void> {
  console.error('\n=== CRUD smoke ===');
  const client = await connect();
  const createdRegistry: string[] = [];
  const createdTemplate: string[] = [];

  try {
    // Pre-sweep orphans from a prior crashed run.
    await sweepByPrefix(
      client,
      'list-registries',
      'delete-registry',
      'id'
    );
    await sweepByPrefix(client, 'list-templates', 'delete-template', 'id');

    // --- container registry auth: create → delete ---
    const reg = await call(client, 'create-registry', {
      body: {
        name: `${runId}-reg`,
        username: 'smoke',
        password: 'smoke-pass',
      },
    });
    const regId = idOf(reg);
    if (!regId)
      throw new Error(`registry create returned no id: ${JSON.stringify(reg)}`);
    createdRegistry.push(regId);
    console.error(`  ✓ created registry ${regId}`);

    // --- template: create → get → delete ---
    const tpl = await call(client, 'create-template', {
      body: {
        name: `${runId}-tpl`,
        image: 'runpod/pytorch:2.1.0-py3.10-cuda11.8.0-devel-ubuntu22.04',
        disk: 10,
      },
    });
    const tplId = idOf(tpl);
    if (!tplId)
      throw new Error(`template create returned no id: ${JSON.stringify(tpl)}`);
    createdTemplate.push(tplId);
    console.error(`  ✓ created template ${tplId}`);

    const got = await call(client, 'get-template', { id: tplId });
    if (idOf(got) !== tplId)
      throw new Error('get-template did not round-trip the id');
    console.error('  ✓ get-template round-trip ok');
  } finally {
    // Teardown — best-effort, never let one failure strand the rest.
    for (const id of createdTemplate) {
      try {
        await call(client, 'delete-template', { id });
      } catch (e) {
        console.error(`  ! template ${id} delete failed: ${String(e)}`);
      }
    }
    for (const id of createdRegistry) {
      try {
        await call(client, 'delete-registry', { id });
      } catch (e) {
        console.error(`  ! registry ${id} delete failed: ${String(e)}`);
      }
    }

    // Fail-closed post-verify: listAll pages the full list and THROWS if any
    // page errors (an unverifiable list is a failure, not a silent "clean").
    let leaked: Array<Record<string, unknown>> = [];
    let verifyError: unknown;
    try {
      const regItems = await listAll(client, 'list-registries');
      const tplItems = await listAll(client, 'list-templates');
      leaked = [...regItems, ...tplItems].filter(
        (x) =>
          typeof x.name === 'string' && (x.name as string).startsWith(PREFIX)
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
        `LEAK: ${leaked.length} ${PREFIX}-* resource(s) remain after teardown`
      );
    }
    console.error('  ✓ teardown verified clean');
  }
}

async function main(): Promise<void> {
  await runSmoke();
  console.error('\nCRUD smoke passed.');
}

main().catch((error) => {
  console.error('CRUD smoke FAILED:', error);
  process.exit(1);
});
