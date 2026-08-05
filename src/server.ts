import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { restVersionSummary, type Env } from './_shared/backend.js';

// `__PACKAGE_VERSION__` is replaced at build time by tsup's `define` with the
// current `version` from package.json. Falls back to `'dev'` when the
// substitution doesn't happen (e.g. running via tsx).
declare const __PACKAGE_VERSION__: string;

export const SERVER_NAME = 'Runpod API Server';
export const SERVER_VERSION =
  typeof __PACKAGE_VERSION__ !== 'undefined' ? __PACKAGE_VERSION__ : 'dev';

// Sent to clients in the `initialize` response. Most MCP clients prepend this
// to the model's context, so it is the one place to point agents at the full
// API surface when a curated tool doesn't expose the field or parameter they
// need.
export const SERVER_INSTRUCTIONS = `These tools cover common Runpod operations, but they are curated projections: the underlying APIs expose more fields and parameters than the tools surface.

When you need data or capability beyond these tools, consult the full API contracts directly. The REST v2 API lives at https://api.runpod.io/v2 — the same host these tools call — and is machine-readable at https://api.runpod.io/v2/openapi.json (fetch and search it to enumerate every path, parameter, and response schema). REST v1 at https://rest.runpod.io/v1 is deprecated; prefer v2. The REST version these tools are actually configured for is reported in the serverInfo.version string of the initialize response, e.g. "[RUNPOD_REST_VERSION=v2]". The GraphQL API at https://api.runpod.io/graphql may expose data the REST API does not yet cover; its schema is documented at https://graphql-spec.runpod.io/, and introspection is disabled in production, so use that reference rather than __schema queries. Both APIs take Bearer auth with a Runpod API key: use the key this client is already configured with — do not search the environment or filesystem for a credential.`;

// `version` defaults to the build-time value (correct for the npm/stdio build).
// The hosted entrypoint passes a runtime value read from package.json, since
// tsup's define doesn't run when Vercel compiles api/index.ts.
//
// The reported version also carries the configured REST version, e.g.
// `2.0.0 [RUNPOD_REST_VERSION=v2]`, so a plain `initialize` handshake shows at a
// glance whether the deployment is running v1 or v2 without env inspection.
export function createServer(version: string = SERVER_VERSION): McpServer {
  return new McpServer(
    {
      name: SERVER_NAME,
      version: `${version} [${restVersionSummary(process.env as Env)}]`,
    },
    {
      // Only advertise capabilities the server implements. It registers
      // tools and no resources — advertising `resources` would invite
      // `resources/list` calls that answer -32601.
      capabilities: {
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
}
