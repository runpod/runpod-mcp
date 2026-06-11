import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import { handleMcpRequest } from '../src/http.js';
import { getOAuthMetadata } from '../src/oauth.js';

function getBaseUrl(req: VercelRequest): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ??
    'https';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

/**
 * Runpod GraphQL endpoint used by the OAuth authorize flow. Defaults to the
 * shared dev backend; override in other environments via RUNPOD_GRAPHQL_URL.
 */
function getRunpodGraphqlUrl(): string {
  return (
    process.env.RUNPOD_GRAPHQL_URL ??
    'https://timpietrusky-api.runpod.dev/graphql'
  );
}

/**
 * Base URL of the Runpod console that hosts the OAuth handoff (login) page.
 * Defaults to local dev; override via CONSOLE_BASE_URL.
 */
function getConsoleBaseUrl(): string {
  return process.env.CONSOLE_BASE_URL ?? 'http://localhost:3001';
}

/**
 * Register a pending Claude OAuth request with the Runpod backend and return
 * its id. This is a guest mutation (no auth header). The backend only accepts
 * a clerkAuthorizeUrl that is absolute HTTPS and whose host matches its
 * configured CLERK_DOMAIN.
 */
async function createClaudeOAuthRequest(
  clerkAuthorizeUrl: string
): Promise<string> {
  const query = `mutation { createClaudeOAuthRequest(input: { clerkAuthorizeUrl: ${JSON.stringify(
    clerkAuthorizeUrl
  )} }) { id } }`;

  const response = await fetch(getRunpodGraphqlUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  // The backend may return a non-JSON body (e.g. an upstream error page or an
  // SST live-debug notice when the dev session is down). Surface a clear error
  // instead of a cryptic JSON parse failure.
  const text = await response.text();
  let result: {
    data?: { createClaudeOAuthRequest?: { id?: string } };
    errors?: Array<{ message: string }>;
  };
  try {
    result = JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(
      `createClaudeOAuthRequest got a non-JSON response (HTTP ${response.status}) from ${getRunpodGraphqlUrl()}: ${snippet}`
    );
  }

  if (result.errors && result.errors.length > 0) {
    throw new Error(
      `createClaudeOAuthRequest failed: ${result.errors
        .map((error) => error.message)
        .join(', ')}`
    );
  }

  const id = result.data?.createClaudeOAuthRequest?.id;
  if (!id) {
    throw new Error('createClaudeOAuthRequest did not return an id');
  }

  return id;
}

function encodeBody(body: VercelRequest['body']): string {
  if (typeof body === 'string') {
    return body;
  }

  if (body && typeof body === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, String(item));
        }
      } else if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    return params.toString();
  }

  return '';
}

async function handleProtectedResourceMetadata(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const baseUrl = getBaseUrl(req);
  // Advertise THIS server as the authorization server so Claude discovers our
  // /authorize route (which performs the Clerk + Runpod handoff) rather than
  // talking to Clerk directly.
  console.log('oauth_protected_resource', {
    baseUrl,
    authorizationServer: baseUrl,
  });
  res.status(200).json({
    resource: `${baseUrl}/`,
    authorization_servers: [baseUrl],
    scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
    bearer_methods_supported: ['header'],
    resource_name: 'Runpod MCP server',
  });
}

async function handleAuthorizationServerMetadata(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const baseUrl = getBaseUrl(req);
  const metadata = await getOAuthMetadata();
  console.log('oauth_authorization_server', {
    baseUrl,
    issuer: baseUrl,
    authorizationEndpoint: `${baseUrl}/authorize`,
    upstreamIssuer: metadata.issuer,
    upstreamAuthorizationEndpoint: metadata.authorization_endpoint,
    upstreamTokenEndpoint: metadata.token_endpoint,
  });
  res.status(200).json({
    // This server is the authorization server: issuer must match where this
    // metadata is served, and authorization_endpoint points at our /authorize.
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: metadata.token_endpoint,
    revocation_endpoint: metadata.revocation_endpoint,
    response_types_supported: metadata.response_types_supported ?? ['code'],
    response_modes_supported: metadata.response_modes_supported ?? ['query'],
    grant_types_supported: metadata.grant_types_supported ?? [
      'authorization_code',
      'refresh_token',
    ],
    token_endpoint_auth_methods_supported:
      metadata.token_endpoint_auth_methods_supported ?? [
        'client_secret_basic',
        'client_secret_post',
      ],
    scopes_supported: metadata.scopes_supported ?? [
      'openid',
      'profile',
      'email',
      'offline_access',
    ],
    code_challenge_methods_supported:
      metadata.code_challenge_methods_supported ?? ['S256'],
  });
}

async function handleOpenIdConfiguration(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const metadata = await getOAuthMetadata();
  console.log('openid_configuration', {
    baseUrl: getBaseUrl(req),
    upstreamIssuer: metadata.issuer,
    upstreamAuthorizationEndpoint: metadata.authorization_endpoint,
    upstreamTokenEndpoint: metadata.token_endpoint,
    upstreamUserinfoEndpoint: metadata.userinfo_endpoint,
    upstreamJwksUri: metadata.jwks_uri,
  });

  res.status(200).json(metadata);
}

async function handleAuthorize(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const metadata = await getOAuthMetadata();
    if (!metadata.authorization_endpoint) {
      res
        .status(500)
        .json({ error: 'Missing authorization endpoint metadata.' });
      return;
    }

    // Build the real Clerk authorize URL from the discovered endpoint,
    // preserving Claude's OAuth params (client_id, redirect_uri, state,
    // code_challenge, code_challenge_method, scope, response_type) so that
    // after Clerk login the browser returns to Claude's redirect_uri.
    const requestUrl = new URL(req.url ?? '/', getBaseUrl(req));
    const clerkAuthorizeUrl = new URL(metadata.authorization_endpoint);
    clerkAuthorizeUrl.search = requestUrl.search;

    console.log('oauth_authorize', {
      clientId: requestUrl.searchParams.get('client_id'),
      redirectUri: requestUrl.searchParams.get('redirect_uri'),
      responseType: requestUrl.searchParams.get('response_type'),
      scope: requestUrl.searchParams.get('scope'),
      hasState: !!requestUrl.searchParams.get('state'),
      hasCodeChallenge: !!requestUrl.searchParams.get('code_challenge'),
      codeChallengeMethod: requestUrl.searchParams.get('code_challenge_method'),
      clerkAuthorizeHost: clerkAuthorizeUrl.host,
    });

    // Register the pending OAuth request with the Runpod backend. The backend
    // requires clerkAuthorizeUrl to be absolute HTTPS with a host matching its
    // CLERK_DOMAIN, which the discovered Clerk endpoint satisfies.
    const requestId = await createClaudeOAuthRequest(
      clerkAuthorizeUrl.toString()
    );

    // Hand off to the console login page, which restores the user's session
    // and then forwards to the Claude integration login page carrying the
    // request id.
    const innerRedirect = `/integrations/claude/login?request=${requestId}`;
    const handoffUrl = `${getConsoleBaseUrl()}/login?redirect=${encodeURIComponent(
      innerRedirect
    )}`;

    console.log('oauth_authorize_handoff', { requestId, handoffUrl });
    res.redirect(302, handoffUrl);
  } catch (error) {
    console.error('oauth_authorize_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : 'Failed to start authorization.',
    });
  }
}

async function handleToken(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const metadata = await getOAuthMetadata();
  if (!metadata.token_endpoint) {
    res.status(500).json({ error: 'Missing token endpoint metadata.' });
    return;
  }

  const headers: Record<string, string> = {
    'content-type':
      (req.headers['content-type'] as string | undefined) ??
      'application/x-www-form-urlencoded',
  };
  const authorization = req.headers.authorization;
  if (authorization) {
    headers.authorization = authorization;
  }

  const encodedBody = encodeBody(req.body);
  const requestParams = new URLSearchParams(encodedBody);
  console.log('oauth_token_request', {
    hasAuthorizationHeader: !!authorization,
    authorizationScheme: authorization?.split(' ')[0] ?? null,
    contentType: headers['content-type'],
    grantType: requestParams.get('grant_type'),
    hasCode: !!requestParams.get('code'),
    redirectUri: requestParams.get('redirect_uri'),
    clientId: requestParams.get('client_id'),
    hasCodeVerifier: !!requestParams.get('code_verifier'),
  });

  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers,
    body: encodedBody,
  });

  const responseText = await response.text();
  let parsedResponse: Record<string, unknown> | null = null;
  try {
    parsedResponse = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    parsedResponse = null;
  }

  console.log('oauth_token_response', {
    status: response.status,
    statusText: response.statusText,
    wwwAuthenticate: response.headers.get('www-authenticate'),
    contentType: response.headers.get('content-type'),
    tokenType:
      parsedResponse && typeof parsedResponse.token_type === 'string'
        ? parsedResponse.token_type
        : null,
    scope:
      parsedResponse && typeof parsedResponse.scope === 'string'
        ? parsedResponse.scope
        : null,
    expiresIn:
      parsedResponse && typeof parsedResponse.expires_in === 'number'
        ? parsedResponse.expires_in
        : null,
    hasAccessToken:
      parsedResponse && typeof parsedResponse.access_token === 'string',
    accessTokenShape:
      parsedResponse && typeof parsedResponse.access_token === 'string'
        ? parsedResponse.access_token.split('.').length === 3
          ? 'jwt'
          : 'opaque'
        : null,
    hasRefreshToken:
      parsedResponse && typeof parsedResponse.refresh_token === 'string',
    hasIdToken: parsedResponse && typeof parsedResponse.id_token === 'string',
  });

  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-length') return;
    res.setHeader(key, value);
  });
  res.send(responseText);
}

async function handleRevoke(
  _req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  res.status(501).json({
    error: 'Token revocation proxy is not implemented.',
  });
}

/**
 * Vercel serverless function that exposes the Runpod MCP server over
 * Streamable HTTP. Each request is authenticated via a Bearer token
 * (the caller's Runpod API key) in the Authorization header.
 *
 * Supports GET (SSE stream), POST (JSON-RPC), and DELETE (session close).
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id'
    );
    res.status(204).end();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Mcp-Session-Id, Content-Type'
  );

  const pathname = new URL(req.url ?? '/', getBaseUrl(req)).pathname;

  if (
    req.method === 'GET' &&
    pathname === '/.well-known/oauth-protected-resource'
  ) {
    await handleProtectedResourceMetadata(req, res);
    return;
  }

  if (
    req.method === 'GET' &&
    pathname === '/.well-known/oauth-authorization-server'
  ) {
    await handleAuthorizationServerMetadata(req, res);
    return;
  }

  if (
    req.method === 'GET' &&
    pathname === '/.well-known/openid-configuration'
  ) {
    await handleOpenIdConfiguration(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/authorize') {
    await handleAuthorize(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/token') {
    await handleToken(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/revoke') {
    await handleRevoke(req, res);
    return;
  }

  await handleMcpRequest(
    req as unknown as import('node:http').IncomingMessage,
    res as unknown as import('node:http').ServerResponse
  );
}
