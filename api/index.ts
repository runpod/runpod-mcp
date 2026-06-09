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
  const metadata = await getOAuthMetadata();
  console.log('oauth_protected_resource', {
    baseUrl,
    authorizationServer: metadata.issuer,
  });
  res.status(200).json({
    resource: `${baseUrl}/`,
    authorization_servers: [metadata.issuer],
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
    upstreamIssuer: metadata.issuer,
    upstreamAuthorizationEndpoint: metadata.authorization_endpoint,
    upstreamTokenEndpoint: metadata.token_endpoint,
  });
  res.status(200).json({
    issuer: metadata.issuer,
    authorization_endpoint: metadata.authorization_endpoint,
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
  const metadata = await getOAuthMetadata();
  if (!metadata.authorization_endpoint) {
    res.status(500).json({ error: 'Missing authorization endpoint metadata.' });
    return;
  }

  const target = new URL(metadata.authorization_endpoint);
  const requestUrl = new URL(req.url ?? '/', getBaseUrl(req));
  target.search = requestUrl.search;
  console.log('oauth_authorize_redirect', {
    target: target.toString(),
    clientId: requestUrl.searchParams.get('client_id'),
    redirectUri: requestUrl.searchParams.get('redirect_uri'),
    responseType: requestUrl.searchParams.get('response_type'),
    scope: requestUrl.searchParams.get('scope'),
    resource: requestUrl.searchParams.get('resource'),
  });
  res.redirect(302, target.toString());
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
