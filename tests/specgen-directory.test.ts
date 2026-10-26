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
import { DIRECTORY_API_REFERENCE } from '#src/specgen/on-demand';
import { generatedTools } from '#src/specgen/generated/tools.gen';
import {
  DIRECTORY_TOOLS,
  directoryOmittedInputs,
  profileForPath,
} from '#src/specgen/profile';
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
  for (const [name, decision] of Object.entries(DIRECTORY_TOOLS))
    assert.equal(names.has(name), decision.include, `${name}: wrong surface`);
  assert.deepEqual(resources, []);
  assert.equal(instructions, DIRECTORY_INSTRUCTIONS);
  assert.match(
    instructions ?? '',
    /https:\/\/docs\.runpod\.io\/api-reference-v2\/overview/
  );

  // Every tool is listed with its complete schema, never a call shape, less
  // only the inputs it omits.
  for (const tool of tools) {
    const source = [...curatedTools, ...generatedTools].find(
      (candidate) => candidate.name === tool.name
    );
    if (!source) continue;
    const omitted = directoryOmittedInputs(tool.name);
    const properties = { ...(source.inputSchema.properties as object) };
    for (const key of omitted)
      delete (properties as Record<string, unknown>)[key];
    assert.deepEqual(tool.inputSchema.properties, properties, tool.name);
  }
});

// Every tool the server can serve needs an explicit directory decision, so a
// regenerated or newly written tool cannot reach the directory unreviewed.
test('every tool has a directory decision, and every decision names a real tool', async () => {
  // Both profiles: some directory tools (start-pod) exist only there.
  const served: string[] = [];
  for (const profile of ['default', 'directory'] as const) {
    const client = await connect({ ...ALP, profile });
    const { tools } = await client.listTools();
    await client.close();
    served.push(...tools.map((tool) => tool.name));
  }
  const unclassified = served.filter((name) => !(name in DIRECTORY_TOOLS));
  assert.deepEqual(
    unclassified,
    [],
    'Classify these in DIRECTORY_TOOLS (src/specgen/profile.ts) per specgen/DIRECTORY_POLICY.md'
  );
  const stale = Object.keys(DIRECTORY_TOOLS).filter(
    (name) => !served.includes(name)
  );
  assert.deepEqual(stale, [], 'Remove these from DIRECTORY_TOOLS');
  for (const [name, decision] of Object.entries(DIRECTORY_TOOLS))
    if (!decision.include)
      assert.ok(decision.reason.trim(), `${name} needs an exclusion reason`);
});

// Input names that ask for an access credential, which OpenAI's directory
// forbids collecting. Plural "tokens" (max_tokens) is a count, not a token.
const CREDENTIAL_INPUT =
  /pass(word|wd|phrase)?|secret|token(?!s)|api_?key|private_?key|credential/i;

function credentialInputs(node: unknown, at: string, found: string[]) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) credentialInputs(item, at, found);
    return;
  }
  const schema = node as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(properties)) {
    if (CREDENTIAL_INPUT.test(key)) found.push(`${at}.${key}`);
    credentialInputs(value, `${at}.${key}`, found);
  }
  for (const key of [
    'items',
    'allOf',
    'anyOf',
    'oneOf',
    'additionalProperties',
  ])
    credentialInputs(schema[key], at, found);
  for (const [key, value] of Object.entries(
    (schema.$defs ?? {}) as Record<string, unknown>
  ))
    credentialInputs(value, `${at}#${key}`, found);
}

test('no directory tool asks for a credential as input', async () => {
  const client = await connect({ profile: 'directory' });
  const { tools } = await client.listTools();
  await client.close();
  const found: string[] = [];
  for (const tool of tools)
    credentialInputs(tool.inputSchema, tool.name, found);
  assert.deepEqual(
    found,
    [],
    'Exclude the tool or omit the input in DIRECTORY_TOOLS (src/specgen/profile.ts)'
  );
});

test('directory tools that take a request body name the API they call', async () => {
  const client = await connect({ profile: 'directory' });
  const { tools } = await client.listTools();
  await client.close();
  const withBody = tools.filter(
    (tool) => 'body' in ((tool.inputSchema.properties ?? {}) as object)
  );
  assert.ok(withBody.some((tool) => tool.name === 'create-pod'));
  for (const tool of withBody)
    assert.ok(
      tool.description?.endsWith(DIRECTORY_API_REFERENCE),
      `${tool.name} does not reference the API`
    );
  // The reference starts a new sentence, even after a description that
  // has no closing period (create-delegation).
  for (const tool of withBody)
    assert.match(
      tool.description!,
      /[.!?] Calls the Runpod REST API v2: /,
      `${tool.name} runs into the API reference`
    );
  const listPods = tools.find((tool) => tool.name === 'list-pods');
  assert.ok(!listPods?.description?.includes(DIRECTORY_API_REFERENCE));
});

test('no directory schema shows a credential as an example', async () => {
  const client = await connect({ profile: 'directory' });
  const { tools } = await client.listTools();
  await client.close();
  const found: string[] = [];
  const walk = (node: unknown, at: string) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'examples' && CREDENTIAL_INPUT.test(JSON.stringify(value)))
        found.push(at);
      walk(value, `${at}.${key}`);
    }
  };
  for (const tool of tools) walk(tool.inputSchema, tool.name);
  assert.deepEqual(found, []);
});

test('directory profile refuses an omitted input', async () => {
  const client = await connect({ profile: 'directory' });
  const result = (await client.callTool({
    name: 'run-endpoint',
    arguments: {
      endpointId: 'e1',
      input: {},
      s3Config: {
        accessId: 'a',
        accessSecret: 'b',
        bucketName: 'c',
        endpointUrl: 'https://s3.test',
      },
    },
  })) as { isError?: boolean; content: Array<{ text: string }> };
  await client.close();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /s3Config/);
});

test('directory profile serves one tool per Pod transition instead of pod-action', async () => {
  const client = await connect({ profile: 'directory' });
  const { tools } = await client.listTools();
  await client.close();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.has('pod-action'), false);
  assert.ok(byName.has('delete-pod'));
  for (const [name, destructive] of [
    ['start-pod', false],
    ['stop-pod', true],
    ['restart-pod', true],
  ] as const) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} missing`);
    assert.deepEqual(tool.inputSchema.required, ['id']);
    assert.equal(tool.annotations?.destructiveHint, destructive, name);
    assert.equal(tool.annotations?.readOnlyHint, false, name);
  }
});

test('directory profile refuses calls to tools it does not list', async () => {
  const client = await connect({ profile: 'directory' });
  for (const name of ['create-secret', 'create-registry', 'read-guide']) {
    const result = (await client.callTool({
      name,
      arguments: { body: { name: 'x', value: 'y' } },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(result.isError, true, `${name} ran on the directory profile`);
  }
  await client.close();
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
  // OpenAI's server-instruction scan holds text that names secrets or
  // credentials for human review.
  assert.doesNotMatch(
    DIRECTORY_INSTRUCTIONS,
    /secret|credential|password|token|ssh key|api key/i
  );
});

test('default profile keeps its tools and guards REST fallback credentials', async () => {
  const client = await connect(ALP);
  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  const instructions = client.getInstructions();
  await client.close();
  assert.match(
    instructions ?? '',
    /https:\/\/docs\.runpod\.io\/api-reference-v2\/overview/
  );
  assert.match(instructions ?? '', /Never read a client's credential store/);
  assert.match(instructions ?? '', /Do not send non-GET requests/);
  assert.doesNotMatch(
    instructions ?? '',
    /Claude Code-credentials|\.claude\.json|mcpOAuth/
  );
  const names = new Set(tools.map((tool) => tool.name));
  for (const kept of [
    'list-guides',
    'read-guide',
    'describe-tool',
    'report_feedback',
    'report_how_user_found_runpod',
    'create-secret',
    'update-secret',
    'create-registry',
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
