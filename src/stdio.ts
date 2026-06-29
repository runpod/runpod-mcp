import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import fetch from 'node-fetch';
import { createServer } from './server.js';
import { registerTools } from './tools.js';
import {
  createV2Prober,
  restV2Base,
  wantsAutoProbe,
  type ProbeFetch,
} from './_shared/backend.js';

// Get API key from environment variable
const API_KEY = process.env.RUNPOD_API_KEY;
if (!API_KEY) {
  console.error('RUNPOD_API_KEY environment variable is required');
  process.exit(1);
}

async function main(apiKey: string): Promise<void> {
  // `auto` mode (stdio only): probe v2 once at startup and pass the resolved
  // verdict to the tools. Explicit v1/v2 needs no probe.
  let v2Available: boolean | undefined;
  if (wantsAutoProbe(process.env)) {
    const probe = createV2Prober({
      // node-fetch's signature is wider than the `{ status }` the prober needs.
      fetch: fetch as unknown as ProbeFetch,
      baseUrl: restV2Base(process.env),
      apiKey,
    });
    v2Available = await probe();
  }

  const server = createServer();
  registerTools(server, { apiKey, transport: 'stdio' }, { v2Available });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main(API_KEY).catch((error) => {
  console.error('Failed to start Runpod MCP server:', error);
  process.exit(1);
});
