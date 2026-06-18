import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// `__PACKAGE_VERSION__` is replaced at build time by tsup's `define` with the
// current `version` from package.json. Falls back to `'dev'` when the
// substitution doesn't happen (e.g. running via tsx).
declare const __PACKAGE_VERSION__: string;

export const SERVER_NAME = 'Runpod API Server';
export const SERVER_VERSION =
  typeof __PACKAGE_VERSION__ !== 'undefined' ? __PACKAGE_VERSION__ : 'dev';

// `version` defaults to the build-time value (correct for the npm/stdio build).
// The hosted entrypoint passes a runtime value read from package.json, since
// tsup's define doesn't run when Vercel compiles api/index.ts.
export function createServer(version: string = SERVER_VERSION): McpServer {
  return new McpServer({
    name: SERVER_NAME,
    version,
    capabilities: {
      resources: {},
      tools: {},
    },
  });
}
