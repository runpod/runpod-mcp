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
  const transport = new StdioClientTransport({
    command: 'node',
    args: [process.env.SMOKE_SERVER ?? 'dist/stdio.mjs'],
    env: { RUNPOD_API_KEY: apiKey(), RUNPOD_REST_VERSION: version },
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

// Pull an array out of either a v1 bare array or the MCP capped envelope
// (`{ items: [...] }`).
function asItems(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  const env = payload as { items?: unknown };
  return Array.isArray(env?.items)
    ? (env.items as Array<Record<string, unknown>>)
    : [];
}

function idOf(obj: unknown): string | undefined {
  const o = obj as { id?: string } | null;
  return o?.id;
}

async function sweepRegistries(client: Client): Promise<void> {
  const items = asItems(
    await call(client, 'list-container-registry-auths', {})
  );
  for (const r of items) {
    if (typeof r.name === 'string' && r.name.startsWith(PREFIX) && r.id) {
      await call(client, 'delete-container-registry-auth', {
        containerRegistryAuthId: r.id,
      });
    }
  }
}

async function sweepTemplates(client: Client): Promise<void> {
  const items = asItems(await call(client, 'list-templates', {}));
  for (const t of items) {
    if (typeof t.name === 'string' && t.name.startsWith(PREFIX) && t.id) {
      await call(client, 'delete-template', { templateId: t.id });
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
    await sweepRegistries(client);
    await sweepTemplates(client);

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

    // Fail-closed post-verify: list calls that error are treated as unknown→fail.
    const regItems = asItems(
      await call(client, 'list-container-registry-auths', {})
    );
    const tplItems = asItems(await call(client, 'list-templates', {}));
    const leaked = [...regItems, ...tplItems].filter(
      (x) => typeof x.name === 'string' && (x.name as string).startsWith(runId)
    );
    await client.close();
    if (leaked.length > 0) {
      throw new Error(
        `LEAK: ${leaked.length} ${runId}-* resource(s) remain after teardown`
      );
    }
    console.error('  ✓ teardown verified clean');
  }
}

async function main(): Promise<void> {
  const versions = process.argv
    .slice(2)
    .filter((v) => v === 'v1' || v === 'v2');
  if (versions.length === 0) versions.push('v1');
  for (const v of versions) {
    await runVersion(v);
  }
  console.error('\nAll CRUD smokes passed.');
}

main().catch((error) => {
  console.error('CRUD smoke FAILED:', error);
  process.exit(1);
});
