import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { registerTools } from './tools.js';
import { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Extract the bearer token from an HTTP request's Authorization header.
 * Returns null if the header is missing or malformed.
 */
function extractBearerToken(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') return null;
  return parts[1];
}

/**
 * Whether this deployment advertises the OAuth ("Sign in with Runpod") flow.
 * Enabled by setting MCP_OAUTH_ENABLED=true. When off, the hosted server still
 * works as pure token passthrough (the caller supplies a Runpod API key as the
 * bearer token); it just does not advertise the sign-in challenge.
 */
function isOAuthEnabled(): boolean {
  return process.env.MCP_OAUTH_ENABLED === 'true';
}

function getBaseUrl(req: IncomingMessage): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ??
    'https';
  const host = req.headers.host;
  if (!host) {
    throw new Error('Missing Host header');
  }

  return `${proto}://${host}`;
}

function writeUnauthorized(
  req: IncomingMessage,
  res: ServerResponse,
  error: string
): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // When OAuth is configured, advertise the protected-resource metadata so
  // OAuth-capable clients (e.g. Claude) know to start the sign-in flow.
  if (isOAuthEnabled()) {
    headers['WWW-Authenticate'] =
      `Bearer realm="mcp", resource_metadata="${getBaseUrl(
        req
      )}/.well-known/oauth-protected-resource"`;
  }

  res.writeHead(401, headers);
  res.end(JSON.stringify({ error }));
}

/**
 * Handle an incoming HTTP request as a streamable MCP session.
 *
 * Each request gets its own McpServer + transport. The caller's Bearer token
 * is forwarded directly to the Runpod API as the credential — it may be a
 * Runpod API key (set manually by the caller) or a token obtained through the
 * OAuth "Sign in with Runpod" flow. The server holds no credential of its own
 * and never shares one across users.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const bearerToken = extractBearerToken(req);
  console.log('mcp_request', {
    method: req.method,
    url: req.url,
    hasBearerToken: !!bearerToken,
    oauthEnabled: isOAuthEnabled(),
  });
  if (!bearerToken) {
    writeUnauthorized(
      req,
      res,
      'Missing or invalid Authorization header. Provide a Bearer token.'
    );
    return;
  }

  const server = createServer();
  registerTools(server, { apiKey: bearerToken, transport: 'http' });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session persistence
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export { registerTools } from './tools.js';
export type { ToolContext } from './tools.js';
