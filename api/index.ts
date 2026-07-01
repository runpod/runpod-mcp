import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { handleMcpRequest } from '../src/http.js';
import { isLoopbackHost, verifyPkce } from '../src/oauth/pkce.js';

// Read the package version at runtime. tsup's build-time `__PACKAGE_VERSION__`
// define does not run here because Vercel compiles api/index.ts itself, so the
// hosted server would otherwise report version "dev" in its outbound User-Agent.
const PACKAGE_VERSION: string = (() => {
  try {
    const { version } = createRequire(import.meta.url)('../package.json') as {
      version?: string;
    };
    return version ?? 'dev';
  } catch {
    return 'dev';
  }
})();

// Verbose logging gate. The authorize/token flows log request ids (which are
// live, single-use auth codes) only when MCP_VERBOSE_LOGS=true.
const VERBOSE = process.env.MCP_VERBOSE_LOGS === 'true';

function getBaseUrl(req: VercelRequest): string {
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ??
    'https';
  const host = req.headers.host;
  if (!host) {
    throw new Error('Missing Host header');
  }
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
  return process.env.CONSOLE_BASE_URL ?? 'https://console.runpod.io';
}

// Redirect URIs we will hand the authorization code (→ a minted API key) to.
// Exact-match for hosted clients; loopback is allowed on any port per RFC 8252.
// Extend via MCP_ALLOWED_REDIRECT_URIS (comma-separated) for other clients/tests.
const DEFAULT_ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

function getAllowedRedirectUris(): string[] {
  const extra = (process.env.MCP_ALLOWED_REDIRECT_URIS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_ALLOWED_REDIRECT_URIS, ...extra];
}

/**
 * Whether we may deliver the authorization code to this redirect_uri. Loopback
 * (http, any port) is always allowed for native clients; everything else must
 * exactly match the configured allowlist. This stops an attacker from crafting
 * an /authorize link that ships the code (and thus a real API key) to a host
 * they control.
 */
function isRedirectUriAllowed(redirectUri: string | null): boolean {
  if (!redirectUri) return false;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return true;
  return getAllowedRedirectUris().includes(redirectUri);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Name for the minted Runpod API key, shown in the user's dashboard. Defaults
 * to "runpod-mcp" so keys minted through this server are identifiable and
 * revocable. Override (or set to empty) via RUNPOD_API_KEY_NAME.
 *
 * Note: the `apiKeyName` argument must be deployed on the target flash backend
 * — sending it to a backend that hasn't shipped it yet fails with "Unknown
 * argument". Set RUNPOD_API_KEY_NAME="" to suppress it for such a backend.
 */
function getApiKeyName(): string | null {
  return process.env.RUNPOD_API_KEY_NAME ?? 'runpod-mcp';
}

interface FlashAuthRequestStatus {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED' | 'CONSUMED';
  apiKey: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
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
async function createFlashAuthRequest(
  codeChallenge?: string | null,
  codeChallengeMethod?: string | null
): Promise<string> {
  const parts: string[] = [];
  const apiKeyName = getApiKeyName();
  if (apiKeyName) parts.push(`apiKeyName: ${JSON.stringify(apiKeyName)}`);
  // Only sent when the client supplied a challenge, so a non-PKCE flow never
  // references the arg (which requires the DR-1398 backend field to be deployed).
  if (codeChallenge) parts.push(`codeChallenge: ${JSON.stringify(codeChallenge)}`);
  if (codeChallengeMethod)
    parts.push(`codeChallengeMethod: ${JSON.stringify(codeChallengeMethod)}`);
  const args = parts.length ? `(${parts.join(', ')})` : '';
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
    )}) { id status apiKey codeChallenge codeChallengeMethod } }`,
    'flashAuthRequestStatus'
  );
}

function encodeBody(body: VercelRequest['body']): string {
  if (typeof body === 'string') {
    return body;
  }

  if (Buffer.isBuffer(body)) {
    return body.toString();
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
    // Advertise S256 PKCE so OAuth clients that require it (e.g. Claude Code,
    // per RFC 8414/8252) will start the flow. This is now enforced: /authorize
    // persists the code_challenge on the flash auth request and /token verifies
    // the code_verifier against it before returning the key (see verifyPkce).
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
    const codeChallenge = requestUrl.searchParams.get('code_challenge');
    const codeChallengeMethod = requestUrl.searchParams.get(
      'code_challenge_method'
    );

    // Reject before doing anything: the authorization code redeems into a real
    // API key, so we only ever deliver it to an allowlisted redirect_uri.
    if (!isRedirectUriAllowed(redirectUri)) {
      console.warn('oauth_authorize_rejected_redirect_uri', { redirectUri });
      res.status(400).json({
        error: 'invalid_request',
        error_description:
          'redirect_uri is not allowed. It must be a registered client callback or a loopback address.',
      });
      return;
    }

    // 1. Create a guest flash auth request; its id is the OAuth code. The PKCE
    //    challenge (if any) is persisted with it and verified at /token.
    const requestId = await createFlashAuthRequest(
      codeChallenge,
      codeChallengeMethod
    );

    console.log('oauth_authorize', {
      clientId: requestUrl.searchParams.get('client_id'),
      redirectUri,
      responseType: requestUrl.searchParams.get('response_type'),
      hasState: !!state,
      hasCodeChallenge: !!requestUrl.searchParams.get('code_challenge'),
      // requestId is a live, single-use auth code — only log it when verbose.
      ...(VERBOSE ? { requestId } : {}),
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

    // Don't log the full handoff URL (it embeds the auth code); log only the
    // console host, and the code itself only when verbose.
    console.log('oauth_authorize_handoff', {
      consoleHost: new URL(getConsoleBaseUrl()).host,
      ...(VERBOSE ? { requestId } : {}),
    });
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
  // Re-validate the redirect_uri here too: a token request must come from a
  // client whose callback we trust (defense in depth alongside /authorize).
  if (!isRedirectUriAllowed(params.get('redirect_uri'))) {
    tokenError(
      res,
      400,
      'invalid_grant',
      'redirect_uri is missing or not allowed.'
    );
    return;
  }

  try {
    // The user is redirected back to the client only after approval, so the
    // request is usually already APPROVED. We poll for most of the function's
    // budget (~45s, well under the 60s maxDuration) rather than returning a
    // non-retryable `authorization_pending` early, since a browser-redirect
    // client typically treats a token-endpoint 400 as terminal.
    //
    // Reading an APPROVED request via the guest `flashAuthRequestStatus` query
    // atomically transitions it to CONSUMED and returns the minted key exactly
    // once (backend: model/src/flash/authRequests.ts), so this poll cannot hand
    // the same key out twice.
    const maxAttempts = 20;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await getFlashAuthStatus(code);
      console.log('oauth_token_poll', {
        attempt,
        status: status.status,
        hasApiKey: !!status.apiKey,
        hasCodeChallenge: !!status.codeChallenge,
      });

      // PKCE gate — run before honoring an APPROVED request so a missing/wrong
      // verifier never yields a key. On a PENDING poll this rejects a bad
      // verifier early, before the user approves. (An APPROVED read consumes the
      // code atomically in the backend, so a failure there still burns the code;
      // the key is never returned, which is the property PKCE protects.)
      const pkceError = verifyPkce({
        codeChallenge: status.codeChallenge,
        codeChallengeMethod: status.codeChallengeMethod,
        codeVerifier: params.get('code_verifier'),
        redirectUri: params.get('redirect_uri'),
      });
      if (pkceError) {
        console.warn('oauth_token_pkce_rejected', { attempt });
        tokenError(res, 400, 'invalid_grant', pkceError);
        return;
      }

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
    res as unknown as import('node:http').ServerResponse,
    { serverVersion: PACKAGE_VERSION }
  );
}
