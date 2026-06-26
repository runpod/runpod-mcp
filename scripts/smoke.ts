import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SERVER_VERSION } from '../src/server.js';

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

  // Forward the API key AND the REST routing env to the spawned server, so
  // `smoke:stdio` can target dev/v2 the same way the HTTP path does. Without
  // this passthrough the child booted with prod-v1 defaults regardless of the
  // caller's env. Pass through every RUNPOD_REST* var (version, per-resource
  // overrides, v1/v2 base URLs) plus the serverless + public-GraphQL bases.
  const childEnv: Record<string, string> = { RUNPOD_API_KEY: apiKey };
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      key.startsWith('RUNPOD_REST') ||
      key === 'RUNPOD_SERVERLESS_API_URL' ||
      key === 'RUNPOD_PUBLIC_GRAPHQL_URL'
    ) {
      childEnv[key] = value;
    }
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

// List tools now return a `{ items, pagination }` envelope (the context-overflow
// cap); older bare-array responses are still handled. Reduce either to the array.
function unwrapItems(parsed: unknown): unknown {
  if (
    parsed &&
    typeof parsed === 'object' &&
    'items' in parsed &&
    Array.isArray((parsed as { items: unknown }).items)
  ) {
    return (parsed as { items: unknown[] }).items;
  }
  return parsed;
}

function summarizeGpuTypes(result: unknown) {
  const gpuTypes = unwrapItems(parseToolText(result));
  if (!Array.isArray(gpuTypes)) {
    return [];
  }

  return gpuTypes.slice(0, 3).map((gpu) => {
    if (!gpu || typeof gpu !== 'object') {
      return gpu;
    }

    const item = gpu as Record<string, unknown>;
    // v1/GraphQL and v2 REST use different field names for the same data:
    //   v1: displayName / memoryGb / stockStatus
    //   v2: name        / memory   / (secure flag, no stockStatus)
    // Read whichever is present so the summary is non-empty on both surfaces.
    return {
      id: item.id,
      displayName: item.displayName ?? item.name,
      memoryGb: item.memoryGb ?? item.memory,
      ...(item.stockStatus !== undefined
        ? { stockStatus: item.stockStatus }
        : {}),
      ...(item.secure !== undefined ? { secure: item.secure } : {}),
    };
  });
}

function summarizePods(result: unknown) {
  const pods = unwrapItems(parseToolText(result));
  if (!Array.isArray(pods)) {
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
        desiredStatus: item.desiredStatus,
        imageName: item.imageName,
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
    const gpuTypes = await client.callTool({
      name: 'list-gpu-types',
      arguments: {
        searchTerm: 'A100',
        includeUnavailable: false,
      },
    });
    const pods = await client.callTool({
      name: 'list-pods',
      arguments: {},
    });

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
