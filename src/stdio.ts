import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { registerTools } from './tools.js';

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
