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

// v2 list responses wrap their array under a named key: list-gpu-types
// answers `{ gpus }`, list-pods `{ pods, pagination }`.
function listField(parsed: unknown, key: string): unknown[] | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const value = (parsed as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

function summarizeGpuTypes(parsed: unknown) {
  const gpuTypes = listField(parsed, 'gpus');
  if (!gpuTypes) {
    return [];
  }

  return gpuTypes.slice(0, 3).map((gpu) => {
    if (!gpu || typeof gpu !== 'object') {
      return gpu;
    }

    const item = gpu as Record<string, unknown>;
    return {
      id: item.id,
      name: item.name,
      memory: item.memory,
      secure: item.secure,
    };
  });
}

function summarizePods(parsed: unknown) {
  const pods = listField(parsed, 'pods');
  if (!pods) {
    return { podCount: null, samplePods: [] };
  }

  return {
    podCount: pods.length,
    samplePods: pods.slice(0, 3).map((pod) => {
      if (!pod || typeof pod !== 'object') {
        return pod;
      }

      const item = pod as Record<string, unknown>;
      return {
        id: item.id,
        name: item.name,
        status: item.status,
        image: item.image,
      };
    }),
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
