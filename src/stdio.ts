import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { registerTools } from './tools.js';

// Detect the install wizard subcommand (`add` / `remove`). In this mode we run
// the interactive installer instead of starting the stdio server, and the API
// key is collected by the wizard rather than required up front.
const WIZARD_SUBCOMMANDS = ['add', 'remove'];
const subcommand = process.argv[2];
const isWizardMode = WIZARD_SUBCOMMANDS.includes(subcommand);

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

  const server = createServer();

  // Register all tools with the API key from the environment
  registerTools(server, { apiKey: API_KEY, transport: 'stdio' });

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  server.connect(transport);
}
