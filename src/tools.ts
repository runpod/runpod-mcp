import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createToolRuntime,
  type ToolContext,
  type ToolDeps,
} from './tools/runtime.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerPodTools } from './tools/pods.js';
import { registerEndpointTools } from './tools/endpoints.js';
import { registerJobTools } from './tools/jobs.js';
import { registerTemplateTools } from './tools/templates.js';
import { registerNetworkVolumeTools } from './tools/network-volumes.js';
import { registerRegistryTools } from './tools/registries.js';

// Re-export so existing importers (entrypoints, tests) keep their import path.
export type { ToolContext } from './tools/runtime.js';

/**
 * Register all Runpod tools on the given MCP server instance.
 *
 * The tool surface is split by resource under `src/tools/<resource>.ts`; this
 * function builds the shared runtime (caller-tracking, authenticated REST/
 * Serverless/GraphQL clients, the v1/v2 backend resolver) once and threads it
 * into each per-resource registrar.
 *
 * @param ctx  supplies the API key the request helpers authenticate with.
 * @param deps optional test seam (inject a fake fetch / the resolved v2-probe
 *             verdict). Production passes nothing.
 */
export function registerTools(
  server: McpServer,
  ctx: ToolContext,
  deps: ToolDeps = {}
): void {
  const rt = createToolRuntime(server, ctx, deps);

  registerCatalogTools(server, rt);
  registerPodTools(server, rt);
  registerEndpointTools(server, rt);
  registerJobTools(server, rt);
  registerTemplateTools(server, rt);
  registerNetworkVolumeTools(server, rt);
  registerRegistryTools(server, rt);
}
