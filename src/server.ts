import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const SERVER_NAME = 'Runpod API Server';
export const SERVER_VERSION = '1.1.0';

export function createServer(): McpServer {
  return new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    capabilities: {
      resources: {},
      tools: {},
    },
  });
}
