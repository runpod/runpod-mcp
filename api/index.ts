import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';
import { handleMcpRequest } from '../src/http.js';

function getBaseUrl(req: VercelRequest): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ??
    'https';
  const host = req.headers.host;
  return `${proto}://${host}`;
}

/**
 * Runpod GraphQL endpoint used by the OAuth authorize flow (the flash backend).
 * Defaults to production; override via RUNPOD_GRAPHQL_URL (e.g. a dev backend).
 */
function getRunpodGraphqlUrl(): string {
  return process.env.RUNPOD_GRAPHQL_URL ?? 'https://api.runpod.io/graphql';
}

/**
 * Base URL of the Runpod console that hosts the OAuth handoff (login) page.
 * Defaults to local dev; override via CONSOLE_BASE_URL.
 */
function getConsoleBaseUrl(): string {
  return process.env.CONSOLE_BASE_URL ?? 'http://localhost:3000';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Optional name for the minted Runpod API key, shown in the user's dashboard.
 * Set RUNPOD_API_KEY_NAME (e.g. "runpod-mcp") to pass it through to the flash
 * backend. Left unset by default because the `apiKeyName` argument only exists
 * on backends that have shipped it — sending it to one that hasn't fails with
 * "Unknown argument". Omitting it falls back to the backend's default name.
 */
function getApiKeyName(): string | null {
  return process.env.RUNPOD_API_KEY_NAME ?? null;
}

interface FlashAuthRequestStatus {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'CONSUMED';
  apiKey: string | null;
}

/**
 * Make a guest (unauthenticated) GraphQL call to the flash backend. Surfaces
 * non-JSON responses (e.g. an SST live-debug notice when the dev session is
 * down) as a clear error instead of a cryptic JSON parse failure.
 */
async function flashGraphql<T>(query: string, field: string): Promise<T> {
  const url = getRunpodGraphqlUrl();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  const text = await response.text();
  let result: { data?: Record<string, T>; errors?: Array<{ message: string }> };
  try {
    result = JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(
      `${field} got a non-JSON response (HTTP ${response.status}) from ${url}: ${snippet}`
    );
  }

  if (result.errors && result.errors.length > 0) {
    throw new Error(
      `${field} failed: ${result.errors.map((e) => e.message).join(', ')}`
    );
  }

  const data = result.data?.[field];
  if (data === undefined || data === null) {
    throw new Error(`${field} returned no data`);
  }
  return data;
}

/**
 * Create a pending flash auth request (guest mutation, no auth header) and
 * return its id. The id doubles as the OAuth authorization code.
 */
async function createFlashAuthRequest(): Promise<string> {
  const apiKeyName = getApiKeyName();
  const args = apiKeyName ? `(apiKeyName: ${JSON.stringify(apiKeyName)})` : '';
  const data = await flashGraphql<{ id: string }>(
    `mutation { createFlashAuthRequest${args} { id } }`,
    'createFlashAuthRequest'
  );
  return data.id;
}

/**
 * Read the current status of a flash auth request (guest query). Once the user
 * approves it in the console, the backend mints and returns a Runpod API key.
 */
async function getFlashAuthStatus(id: string): Promise<FlashAuthRequestStatus> {
  return flashGraphql<FlashAuthRequestStatus>(
    `query { flashAuthRequestStatus(flashAuthRequestId: ${JSON.stringify(
      id
    )}) { id status apiKey } }`,
    'flashAuthRequestStatus'
  );
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

function handleProtectedResourceMetadata(
  req: VercelRequest,
  res: VercelResponse
): void {
  const baseUrl = getBaseUrl(req);
  // Advertise THIS server as the authorization server so Claude discovers our
  // /authorize and /token routes.
  res.status(200).json({
    resource: `${baseUrl}/`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    resource_name: 'Runpod MCP server',
  });
}

function handleAuthorizationServerMetadata(
  req: VercelRequest,
  res: VercelResponse
): void {
  const baseUrl = getBaseUrl(req);
  // This server is the full authorization server. The flow is a flash-backed
  // approval: /authorize creates a request and hands off to the console, and
  // /token exchanges the resulting code for the minted Runpod API key. There is
  // no upstream identity provider involved at this layer (the console handles
  // the actual user login).
  res.status(200).json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  });
}

/**
 * Minimal OAuth 2.0 Dynamic Client Registration (RFC 7591). MCP clients such as
 * Claude register before starting the flow. We are a public client with no
 * client authentication, so we accept the request, echo back the client
 * metadata, and issue a client_id. Nothing is persisted — the token endpoint
 * does not authenticate the client (auth comes from the flash approval).
 */
function handleRegister(req: VercelRequest, res: VercelResponse): void {
  const body =
    req.body && typeof req.body === 'object'
      ? (req.body as Record<string, unknown>)
      : {};
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris
    : [];

  console.log('oauth_register', {
    clientName: body.client_name,
    redirectUris,
  });

  res.status(201).json({
    client_id: `mcp-${randomUUID()}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    client_name:
      typeof body.client_name === 'string' ? body.client_name : 'mcp-client',
  });
}

async function handleAuthorize(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    const requestUrl = new URL(req.url ?? '/', getBaseUrl(req));
    const redirectUri = requestUrl.searchParams.get('redirect_uri');
    const state = requestUrl.searchParams.get('state');

    // 1. Create a guest flash auth request; its id is the OAuth code.
    const requestId = await createFlashAuthRequest();

    console.log('oauth_authorize', {
      clientId: requestUrl.searchParams.get('client_id'),
      redirectUri,
      responseType: requestUrl.searchParams.get('response_type'),
      hasState: !!state,
      hasCodeChallenge: !!requestUrl.searchParams.get('code_challenge'),
      requestId,
    });

    // 2. Hand off to the console login page. We carry the client's redirect_uri
    //    and state through so the login page can return the browser to the
    //    client (redirect_uri?code=<requestId>&state=<state>) once approved.
    const innerParams = new URLSearchParams({ request: requestId });
    if (redirectUri) innerParams.set('redirect_uri', redirectUri);
    if (state) innerParams.set('state', state);
    const innerRedirect = `/integrations/mcp/login?${innerParams.toString()}`;
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

function tokenError(
  res: VercelResponse,
  httpStatus: number,
  error: string,
  description: string
): void {
  res.status(httpStatus).json({ error, error_description: description });
}

/**
 * OAuth token endpoint. Claude exchanges the authorization code (the flash
 * request id) for an access token. We poll the flash request and, once the user
 * has approved it in the console, return the minted Runpod API key as the
 * access token. The MCP then forwards that key to the Runpod API on subsequent
 * requests.
 */
async function handleToken(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const params = new URLSearchParams(encodeBody(req.body));
  const grantType = params.get('grant_type');
  const code = params.get('code');

  console.log('oauth_token_request', {
    grantType,
    hasCode: !!code,
    redirectUri: params.get('redirect_uri'),
    clientId: params.get('client_id'),
    hasCodeVerifier: !!params.get('code_verifier'),
  });

  if (grantType !== 'authorization_code') {
    tokenError(
      res,
      400,
      'unsupported_grant_type',
      `Only authorization_code is supported, got ${grantType ?? 'none'}.`
    );
    return;
  }
  if (!code) {
    tokenError(res, 400, 'invalid_request', 'Missing code parameter.');
    return;
  }

  try {
    // The user is redirected back to Claude only after approval, so the request
    // should already be APPROVED. Poll briefly to absorb any propagation lag.
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await getFlashAuthStatus(code);
      console.log('oauth_token_poll', {
        attempt,
        status: status.status,
        hasApiKey: !!status.apiKey,
      });

      if (status.status === 'APPROVED' || status.status === 'CONSUMED') {
        if (!status.apiKey) {
          // CONSUMED with no key means it was already exchanged once.
          tokenError(
            res,
            400,
            'invalid_grant',
            'Authorization code has already been used.'
          );
          return;
        }
        res.status(200).json({
          access_token: status.apiKey,
          token_type: 'Bearer',
        });
        return;
      }
      if (status.status === 'DENIED') {
        tokenError(res, 400, 'access_denied', 'The user denied the request.');
        return;
      }
      if (status.status === 'EXPIRED') {
        tokenError(
          res,
          400,
          'invalid_grant',
          'The authorization request expired.'
        );
        return;
      }

      // PENDING — wait and retry.
      if (attempt < maxAttempts - 1) await sleep(2000);
    }

    tokenError(
      res,
      400,
      'authorization_pending',
      'The authorization request has not been approved yet.'
    );
  } catch (error) {
    console.error('oauth_token_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    tokenError(
      res,
      500,
      'server_error',
      error instanceof Error ? error.message : 'Token exchange failed.'
    );
  }
}

/**
 * Vercel serverless function that exposes the Runpod MCP server over
 * Streamable HTTP, plus the OAuth routes that let a client obtain a Runpod API
 * key through the flash "Sign in with Runpod" approval flow.
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
    handleProtectedResourceMetadata(req, res);
    return;
  }

  if (
    req.method === 'GET' &&
    pathname === '/.well-known/oauth-authorization-server'
  ) {
    handleAuthorizationServerMetadata(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/authorize') {
    await handleAuthorize(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/register') {
    handleRegister(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/token') {
    await handleToken(req, res);
    return;
  }

  await handleMcpRequest(
    req as unknown as import('node:http').IncomingMessage,
    res as unknown as import('node:http').ServerResponse
  );
}
