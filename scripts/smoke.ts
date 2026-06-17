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

  return new StdioClientTransport({
    command: 'node',
    args: [target],
    env: {
      RUNPOD_API_KEY: apiKey,
    },
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

  return JSON.parse(text);
}

function summarizeGpuTypes(result: unknown) {
  const gpuTypes = parseToolText(result);
  if (!Array.isArray(gpuTypes)) {
    return [];
  }

  return gpuTypes.slice(0, 3).map((gpu) => {
    if (!gpu || typeof gpu !== 'object') {
      return gpu;
    }

    const item = gpu as Record<string, unknown>;
    return {
      id: item.id,
      displayName: item.displayName,
      memoryGb: item.memoryGb,
      stockStatus: item.stockStatus,
    };
  });
}

function summarizePods(result: unknown) {
  const pods = parseToolText(result);
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
