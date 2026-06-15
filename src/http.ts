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
  // Always advertise the protected-resource metadata so OAuth-capable clients
  // (e.g. Claude) know to start the "Sign in with Runpod" flow. Callers who
  // bring their own API key as the bearer token simply never hit this path.
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'WWW-Authenticate': `Bearer realm="mcp", resource_metadata="${getBaseUrl(
      req
    )}/.well-known/oauth-protected-resource"`,
  };

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
  res: ServerResponse,
  opts: { serverVersion?: string } = {}
): Promise<void> {
  const bearerToken = extractBearerToken(req);
  console.log('mcp_request', {
    method: req.method,
    url: req.url,
    hasBearerToken: !!bearerToken,
  });
  if (!bearerToken) {
    writeUnauthorized(
      req,
      res,
      'Missing or invalid Authorization header. Provide a Bearer token.'
    );
    return;
  }

  const server = createServer(opts.serverVersion);
  // In stateless HTTP, a tools/call is a separate request from `initialize`, so
  // the per-request server never sees the MCP `clientInfo`. Fall back to the
  // inbound HTTP User-Agent so caller-tracking still attributes the client.
  registerTools(server, {
    apiKey: bearerToken,
    transport: 'http',
    clientUserAgent: req.headers['user-agent'],
    serverVersion: opts.serverVersion,
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session persistence
  });

  // This per-request server/transport pair is single-use; dispose it when the
  // response closes so listeners don't accumulate on a warm serverless instance.
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  await server.connect(transport);
  // Pass the already-parsed body when the host provides one (e.g. Vercel's
  // VercelRequest exposes `req.body`); the SDK reads the raw stream otherwise.
  await transport.handleRequest(req, res, (req as { body?: unknown }).body);
}

export { registerTools } from './tools.js';
export type { ToolContext } from './tools.js';
