import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SERVER_VERSION } from '#src/server';

type Mode = 'http' | 'stdio';

function getApiKey(): string {
  const apiKey = process.env.RUNPOD_API_KEY;
  if (!apiKey) {
    throw new Error('RUNPOD_API_KEY is required');
  }

  return apiKey;
}

function parseMode(value: string | undefined): Mode {
  if (value === 'http' || value === 'stdio') {
    return value;
  }

  throw new Error('Usage: tsx scripts/smoke.ts <http|stdio> [target]');
}

async function createTransport(mode: Mode) {
  const apiKey = getApiKey();

  if (mode === 'http') {
    const url = process.argv[3] ?? process.env.MCP_SERVER_URL;
    if (!url) {
      throw new Error(
        'Provide the server URL as an argument or MCP_SERVER_URL'
      );
    }

    return new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    });
  }

  const target = process.argv[3] ?? 'dist/stdio.mjs';

  // StdioClientTransport REPLACES (does not merge) the child env: forward the
  // API key plus every host override the specgen surface reads
  // (_shared/hosts.ts) — miss one and "smoke against dev" silently tests prod.
  const childEnv: Record<string, string> = { RUNPOD_API_KEY: apiKey };
  for (const key of [
    'RUNPOD_API_BASE_URL',
    'RUNPOD_SERVERLESS_API_URL',
    'RUNPOD_PUBLIC_GRAPHQL_URL',
    'RUNPOD_AUTHED_GRAPHQL_URL',
  ]) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }

  return new StdioClientTransport({
    command: 'node',
    args: [target],
    env: childEnv,
    stderr: 'inherit',
  });
}

function parseToolText(result: unknown): unknown {
  if (!result || typeof result !== 'object' || !('content' in result)) {
    return null;
  }

  const content = (
    result as { content?: Array<{ type?: string; text?: string }> }
  ).content;
  const text = content?.find((item) => item.type === 'text')?.text;
  if (!text) {
    return null;
  }

  // Tool errors surface as a non-JSON text string (e.g. a network/401 message),
  // so degrade to the raw text instead of throwing a confusing SyntaxError.
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// A smoke call that came back as a tool error must fail the run: a summary of
// an error payload reads as "no GPUs, no pods" and exits 0, which is how stale
// v1 arguments went unnoticed here.
function requireOk(name: string, result: unknown): unknown {
  if (result && typeof result === 'object' && 'isError' in result) {
    if ((result as { isError?: boolean }).isError) {
      throw new Error(
        `${name} returned a tool error: ${JSON.stringify(parseToolText(result))}`
      );
    }
  }
  return parseToolText(result);
}

// A successful call with a drifted shape must fail the run too, or a renamed
// key reads as "no GPUs" and exits 0. v2 list responses wrap their array under
// a named key (list-gpu-types `{ gpus }`, list-pods `{ pods, pagination }`),
// and every field summarized below is required by the v2 spec.
function requireList(name: string, parsed: unknown, key: string): unknown[] {
  const value =
    parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)[key]
      : undefined;
  if (!Array.isArray(value)) {
    throw new Error(
      `${name} returned no \`${key}\` array: ${JSON.stringify(parsed)}`
    );
  }
  return value;
}

function pickRequired(
  name: string,
  item: unknown,
  fields: readonly string[]
): Record<string, unknown> {
  const record =
    item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
  const missing = fields.filter((field) => record[field] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${name} item is missing ${missing.join(', ')}: ${JSON.stringify(item)}`
    );
  }
  return Object.fromEntries(fields.map((field) => [field, record[field]]));
}

function summarizeGpuTypes(parsed: unknown) {
  return requireList('list-gpu-types', parsed, 'gpus')
    .slice(0, 3)
    .map((gpu) =>
      pickRequired('list-gpu-types', gpu, ['id', 'name', 'memory', 'secure'])
    );
}

function summarizePods(parsed: unknown) {
  const pods = requireList('list-pods', parsed, 'pods');
  return {
    podCount: pods.length,
    samplePods: pods
      .slice(0, 3)
      .map((pod) =>
        pickRequired('list-pods', pod, ['id', 'name', 'status', 'image'])
      ),
  };
}

async function main() {
  const mode = parseMode(process.argv[2]);
  const client = new Client({
    name: 'runpod-mcp-smoke-test',
    version: SERVER_VERSION,
  });
  const transport = await createTransport(mode);

  try {
    await client.connect(transport);

    const serverVersion = client.getServerVersion();
    const tools = await client.listTools();
    const gpuTypes = requireOk(
      'list-gpu-types',
      await client.callTool({ name: 'list-gpu-types', arguments: {} })
    );
    const pods = requireOk(
      'list-pods',
      await client.callTool({ name: 'list-pods', arguments: {} })
    );

    console.log(
      JSON.stringify(
        {
          mode,
          serverVersion,
          toolCount: tools.tools.length,
          sampleTools: tools.tools.slice(0, 10).map((tool) => tool.name),
          gpuTypes: summarizeGpuTypes(gpuTypes),
          ...summarizePods(pods),
        },
        null,
        2
      )
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
