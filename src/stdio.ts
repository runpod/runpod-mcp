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

// Detect the install wizard subcommand (`add` / `remove`). In this mode we run
// the interactive installer instead of starting the stdio server, and the API
// key is collected by the wizard rather than required up front.
const WIZARD_SUBCOMMANDS = ['add', 'remove'];
const subcommand = process.argv[2];
const isWizardMode = WIZARD_SUBCOMMANDS.includes(subcommand);

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
      // Surface a transient/timeout fallback to v1 — otherwise `auto` silently
      // pins the session to v1 with no signal (stderr is the MCP log channel).
      warn: (message) => console.error(`[runpod-mcp] ${message}`),
    });
    v2Available = await probe();
  }

  const server = createServer();
  registerTools(server, { apiKey, transport: 'stdio' }, { v2Available });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (isWizardMode) {
  import('./install/wizard.js')
    .then(({ runWizard }) => runWizard(subcommand))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
} else {
  // Get API key from environment variable
  const API_KEY = process.env.RUNPOD_API_KEY;
  if (!API_KEY) {
    console.error('RUNPOD_API_KEY environment variable is required');
    process.exit(1);
  }

  main(API_KEY).catch((error) => {
    console.error('Failed to start Runpod MCP server:', error);
    process.exit(1);
  });
}
