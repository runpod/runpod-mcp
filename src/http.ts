import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { isLikelyJwt, verifyClerkOAuthToken } from './oauth.js';
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

function getHttpUpstreamApiKey(): string | null {
  return (
    process.env.RUNPOD_HTTP_SHARED_API_KEY ?? process.env.RUNPOD_API_KEY ?? null
  );
}

function isOAuthTranslationModeEnabled(): boolean {
  return !!process.env.CLERK_OAUTH_DISCOVERY_URL && !!getHttpUpstreamApiKey();
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

  if (isOAuthTranslationModeEnabled()) {
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
 * Each request gets its own McpServer + transport.
 *
 * Modes:
 * - Default: treat the Bearer token as a direct Runpod API key.
 * - OAuth translation mode: validate Clerk-issued JWTs and translate them to a
 *   server-side Runpod API key for outbound requests. This exists to test
 *   remote OAuth with a non-Runpod Clerk tenant before switching to the real
 *   Runpod identity provider.
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
    bearerTokenShape: bearerToken
      ? isLikelyJwt(bearerToken)
        ? 'jwt'
        : 'opaque'
      : 'missing',
    oauthTranslationMode: isOAuthTranslationModeEnabled(),
  });
  if (!bearerToken) {
    writeUnauthorized(
      req,
      res,
      'Missing or invalid Authorization header. Provide a Bearer token.'
    );
    return;
  }

  let apiKey = bearerToken;

  if (isOAuthTranslationModeEnabled()) {
    if (isLikelyJwt(bearerToken)) {
      try {
        const user = await verifyClerkOAuthToken(bearerToken);
        console.log('mcp_oauth_token_verified', {
          subject: user.subject,
          issuer: user.issuer,
        });
      } catch (error) {
        console.error('mcp_oauth_token_verification_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        writeUnauthorized(req, res, 'Invalid OAuth bearer token.');
        return;
      }
    } else {
      console.log('mcp_oauth_opaque_token_received', {
        translatingWithoutLocalVerification: true,
      });
    }

    const upstreamApiKey = getHttpUpstreamApiKey();
    if (!upstreamApiKey) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'OAuth translation mode is enabled, but RUNPOD_HTTP_SHARED_API_KEY is not configured.',
        })
      );
      return;
    }

    apiKey = upstreamApiKey;
    console.log('mcp_oauth_translation_mode', {
      usingSharedUpstreamApiKey: true,
    });
  }

  const server = createServer();
  registerTools(server, { apiKey });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session persistence
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export { registerTools } from './tools.js';
export type { ToolContext } from './tools.js';
