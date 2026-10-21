// The directory profile (mcp.runpod.io/directory) is what app directories
// list. Their policies reject tool descriptions that instruct the model or
// steer it toward other tools or external instructions, and servers that
// collect conversation data beyond a tool's job. These gates pin that surface,
// and pin the default surface as unchanged.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import handler from '../api/index.js';
import { handleMcpRequest, requestProfile } from '#src/http';
import {
  createSpecgenServer,
  curatedTools,
  DIRECTORY_INSTRUCTIONS,
  type SpecgenServerOptions,
} from '#src/specgen/server';
import { createToolContext } from '#src/specgen/context';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import { DIRECTORY_EXCLUDED_TOOLS, profileForPath } from '#src/specgen/profile';
import { REDACTED, redactSecretEnv } from '#src/specgen/redact';

const ALP = {
  alp: {
    ingestUrl: 'http://127.0.0.1:9/api/alp/submit',
    transport: 'stdio' as const,
  },
};

async function connect(opts: SpecgenServerOptions) {
  const server = createSpecgenServer(
    createToolContext({ apiKey: 'rpa_test' }),
    'test',
    { ...opts, search: async () => ({ status: 200, body: {} as never }) }
  );
  const client = new Client({ name: 'test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

// Phrases that tell the model how to behave rather than say what a tool does.
const DIRECTIVE =
  /\b(state the|only after|before (creating|deleting)|verify the|delete only|terminate only|prefer\b|important\b|explicit go|required before|out of contract|use (it|this|them) (to|for|when|whenever)|call [a-z]+-[a-z-]+|follow up with|playbook|read-guide|list-guides)/i;

test('directory profile: no ALP, guide or describe tools, and full schemas', async () => {
  const client = await connect({ ...ALP, profile: 'directory' });
  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  const instructions = client.getInstructions();
  await client.close();

  const names = new Set(tools.map((tool) => tool.name));
  for (const excluded of [
    ...DIRECTORY_EXCLUDED_TOOLS,
    'report_feedback',
    'save_to_journal',
    'ask_question',
    'read_journal',
    'report_how_user_found_runpod',
  ])
    assert.equal(names.has(excluded), false, `${excluded} is served`);
  assert.deepEqual(resources, []);
  assert.equal(instructions, DIRECTORY_INSTRUCTIONS);

  // Every tool is listed with its complete schema, never a call shape.
  for (const tool of tools) {
    const source = [...curatedTools, ...generatedTools].find(
      (candidate) => candidate.name === tool.name
    );
    if (source) assert.deepEqual(tool.inputSchema, source.inputSchema);
  }
});

test('directory descriptions say what a tool does, name no other tool, and give no directives', async () => {
  const client = await connect({ profile: 'directory' });
  const { tools } = await client.listTools();
  await client.close();
  const names = tools.map((tool) => tool.name);
  const offenders: string[] = [];
  for (const tool of tools) {
    const text = tool.description ?? '';
    const directive = DIRECTIVE.exec(text);
    if (directive) offenders.push(`${tool.name}: "${directive[0]}"`);
    for (const other of names) {
      if (other === tool.name) continue;
      if (new RegExp(`(^|[^a-z-])${other}([^a-z-]|$)`).test(text))
        offenders.push(`${tool.name}: names ${other}`);
    }
  }
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(DIRECTORY_INSTRUCTIONS, DIRECTIVE);
  assert.doesNotMatch(DIRECTORY_INSTRUCTIONS, /plugin|report_|journal/i);
});

test('default profile is unchanged: original descriptions, ALP when configured', async () => {
  const client = await connect(ALP);
  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  await client.close();
  const names = new Set(tools.map((tool) => tool.name));
  for (const kept of [
    'list-guides',
    'read-guide',
    'describe-tool',
    'report_feedback',
    'report_how_user_found_runpod',
  ])
    assert.ok(names.has(kept), `${kept} missing from the default profile`);
  assert.ok(resources.length > 0);
  for (const tool of [...curatedTools, ...generatedTools]) {
    if (!tool.directoryDescription) continue;
    const listed = tools.find((candidate) => candidate.name === tool.name);
    assert.ok(listed?.description?.startsWith(tool.description));
  }
});

test('profileForPath and requestProfile pick the directory surface only at /directory', () => {
  assert.equal(profileForPath('/directory'), 'directory');
  assert.equal(profileForPath('/directory/'), 'directory');
  assert.equal(profileForPath('/'), 'default');
  assert.equal(profileForPath('/directory-x'), 'default');
  assert.equal(requestProfile({ url: '/directory?x=1' }), 'directory');
  assert.equal(requestProfile({ url: '/' }), 'default');
});

test('secret-looking env values are redacted in every profile; secret references are kept', () => {
  const payload = {
    pods: [
      {
        id: 'p1',
        env: {
          JUPYTER_PASSWORD: 'hunter2',
          HF_TOKEN: 'hf_live',
          OPENAI_API_KEY: 'sk-live',
          GH_TOKEN: '{{ RUNPOD_SECRET_GH_TOKEN }}',
          MODEL_NAME: 'qwen',
          PUBLIC_KEY: 'ssh-ed25519 AAAA me',
        },
      },
    ],
  };
  const redacted = redactSecretEnv(payload) as typeof payload;
  const env = redacted.pods[0].env;
  assert.equal(env.JUPYTER_PASSWORD, REDACTED);
  assert.equal(env.HF_TOKEN, REDACTED);
  assert.equal(env.OPENAI_API_KEY, REDACTED);
  assert.equal(env.GH_TOKEN, '{{ RUNPOD_SECRET_GH_TOKEN }}');
  assert.equal(env.MODEL_NAME, 'qwen');
  assert.equal(env.PUBLIC_KEY, 'ssh-ed25519 AAAA me');
  assert.equal(
    payload.pods[0].env.JUPYTER_PASSWORD,
    'hunter2',
    'input mutated'
  );
});

async function withServer<T>(
  listener: Parameters<typeof createServer>[1],
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server: Server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('an unauthenticated request to /directory points at its own resource metadata', async () => {
  const challenges = await withServer(
    async (req, res) => {
      await handleMcpRequest(req, res).catch(() => {});
    },
    async (baseUrl) => {
      const directory = await fetch(`${baseUrl}/directory`, { method: 'POST' });
      const root = await fetch(`${baseUrl}/`, { method: 'POST' });
      return {
        directory: directory.headers.get('www-authenticate') ?? '',
        root: root.headers.get('www-authenticate') ?? '',
      };
    }
  );
  assert.match(
    challenges.directory,
    /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/directory"/
  );
  assert.match(
    challenges.root,
    /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/
  );
});

function fakeGet(url: string) {
  let body: unknown;
  let status: number | undefined;
  const req = {
    method: 'GET',
    url,
    headers: { host: 'mcp.test' },
    body: undefined,
    on() {},
  } as unknown as Parameters<typeof handler>[0];
  const res = {
    setHeader() {
      return this;
    },
    getHeader() {
      return undefined;
    },
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
    send() {
      return this;
    },
    end() {
      return this;
    },
    writeHead(code: number) {
      status = code;
      return this;
    },
    on() {},
  } as unknown as Parameters<typeof handler>[1];
  return { req, res, result: () => ({ status, body }) };
}

test('protected-resource metadata names the directory endpoint as its resource', async () => {
  const directory = fakeGet('/.well-known/oauth-protected-resource/directory');
  await handler(directory.req, directory.res);
  assert.equal(directory.result().status, 200);
  assert.equal(
    (directory.result().body as { resource: string }).resource,
    'https://mcp.test/directory'
  );

  const root = fakeGet('/.well-known/oauth-protected-resource');
  await handler(root.req, root.res);
  assert.equal(
    (root.result().body as { resource: string }).resource,
    'https://mcp.test/'
  );
});
