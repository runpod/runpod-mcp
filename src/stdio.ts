import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SERVER_VERSION } from './server.js';
import { createSpecgenServer } from './specgen/server.js';
import { createToolContext } from './specgen/context.js';

// Detect the install wizard subcommand (`add` / `remove`). In this mode we run
// the interactive installer instead of starting the stdio server, and the API
// key is collected by the wizard rather than required up front.
const WIZARD_SUBCOMMANDS = ['add', 'remove'];
const subcommand = process.argv[2];
const isWizardMode = WIZARD_SUBCOMMANDS.includes(subcommand);

async function main(apiKey: string): Promise<void> {
  // One surface everywhere: stdio serves the same spec-generated tool set
  // and skill resources the hosted path serves (see specgen/DESIGN.md).
  // stdio keeps the 5-minute wait budgets — no gateway reaper applies here.
  const server = createSpecgenServer(
    createToolContext({
      apiKey,
      tracking: { transport: 'stdio', serverVersion: SERVER_VERSION },
    }),
    SERVER_VERSION
  );
  await server.connect(new StdioServerTransport());
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
