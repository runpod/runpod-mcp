import type { VercelRequest, VercelResponse } from '@vercel/node';
import fetch from 'node-fetch';
import { createRequire } from 'node:module';
import { getBaseUrl, handleMcpRequest } from '../src/http.js';
import { handleAlpSubmit } from '../src/alp/ingest.js';
import { handleAlpJournalRead } from '../src/alp/read.js';
import { handleSearch } from '../src/search/route.js';
import {
  isLoopbackHost,
  validatePkceAuthorization,
  validatePkceVerifier,
} from '../src/oauth/pkce.js';
import {
  createHandoffState,
  readHandoffState,
  registerClient,
  registeredRedirects,
} from '../src/oauth/registration.js';

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

// Verbose logging gate. Request IDs are sensitive approval handles.
const VERBOSE = process.env.MCP_VERBOSE_LOGS === 'true';

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
const CHATGPT_CALLBACK =
  /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;

function isRegistrationUriAllowed(uri: string): boolean {
  if (uri.length > 2048) return false;
  if (CHATGPT_CALLBACK.test(uri) || getAllowedRedirectUris().includes(uri))
    return true;
  try {
    const url = new URL(uri);
    return (
      url.protocol === 'http:' && isLoopbackHost(url.hostname) && !url.hash
    );
  } catch {
    return false;
  }
}

function isClientRedirectAllowed(
  clientId: string | null,
  uri: string | null
): boolean {
  if (!uri) return false;
  const registered = clientId ? registeredRedirects(clientId) : null;
  return registered ? registered.includes(uri) : isRedirectUriAllowed(uri);
}

function getCompletionUrl(): string {
  return (
    process.env.MCP_OAUTH_COMPLETE_URL ??
    'https://mcp.getrunpod.io/oauth/complete'
  );
}

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

// node-fetch applies no timeout of its own, and this file runs under
// vercel.json's 60s maxDuration for api/index.ts. A flash backend that accepts
// the connection and goes quiet would otherwise hang the OAuth handshake until
// the platform reaps it — a blank 504 on the one flow the user cannot retry
// their way out of, since they have no credential yet. Tool requests carry
// their own deadlines (src/specgen/context.ts and clients/); these calls
// build their own request, so they are bounded here.
// Exported so the parsing test asserts the real fallback, not a copy of it.
export const DEFAULT_FLASH_GRAPHQL_TIMEOUT_MS = 10_000;
// AbortSignal.timeout takes a uint32: a fractional or out-of-range delay throws
// ERR_OUT_OF_RANGE synchronously, which would 500 BOTH OAuth routes and make
// signing in impossible. Just above int32 it does not throw at all — it warns
// and fires immediately, turning a dial someone raised into a 1ms deadline.
const MAX_FLASH_TIMEOUT_MS = 2_147_483_647;

/**
 * Deadline for one flash-backend call. `MCP_FLASH_TIMEOUT_MS` overrides it —
 * an ops dial for a slow backend, and how the timeout tests reach this path in
 * milliseconds instead of ten real seconds. Anything that is not a positive
 * integer inside the timer's range is ignored, so no value of this variable can
 * disable the deadline or break the routes that depend on it. Exported so the
 * test for that promise calls the real parser.
 */
export function getFlashTimeoutMs(): number {
  const override = Number(process.env.MCP_FLASH_TIMEOUT_MS);
  return Number.isSafeInteger(override) &&
    override > 0 &&
    override <= MAX_FLASH_TIMEOUT_MS
    ? override
    : DEFAULT_FLASH_GRAPHQL_TIMEOUT_MS;
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

/**
 * Make a guest (unauthenticated) GraphQL call to the flash backend. Surfaces
 * non-JSON responses (e.g. an SST live-debug notice when the dev session is
 * down) as a clear error instead of a cryptic JSON parse failure.
 */
async function flashGraphql<T>(
  query: string,
  field: string,
  requestedTimeoutMs?: number
): Promise<T> {
  const url = getRunpodGraphqlUrl();
  const timeoutMs = requestedTimeoutMs ?? getFlashTimeoutMs();
  // Covers the body drain too: a backend can send headers and then stall.
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Awaited<ReturnType<typeof fetch>>;
  let text: string;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal,
    });
    text = await response.text();
  } catch (error) {
    // `signal.aborted`, not the error name — node-fetch and undici label an
    // abort differently, and a transport failure must keep its own message.
    if (!signal.aborted) throw error;
    throw new Error(
      `${field} got no response from ${url} after ${timeoutMs}ms — the Runpod API may be unavailable. Start the sign-in again.`
    );
  }

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
 * return its id. Approval later issues a separate OAuth authorization code.
 */
async function createFlashAuthRequest(codeChallenge: string): Promise<string> {
  const parts: string[] = [];
  const apiKeyName = getApiKeyName();
  if (apiKeyName) parts.push(`apiKeyName: ${JSON.stringify(apiKeyName)}`);
  // These fields require the PKCE-aware flash auth backend schema.
  parts.push(`codeChallenge: ${JSON.stringify(codeChallenge)}`);
  parts.push('codeChallengeMethod: "S256"');
  parts.push('oauthCodeExchange: true');
  const args = parts.length ? `(${parts.join(', ')})` : '';
  const data = await flashGraphql<{ id: string }>(
    `mutation { createFlashAuthRequest${args} { id } }`,
    'createFlashAuthRequest'
  );
  return data.id;
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

// Both discovery documents are derived purely from the request host and are
// fetched by MCP clients on every auth flow, so without this every fetch is a
// function invocation (verified before the change: x-vercel-cache: MISS on
// both). Introduced for the v1 surface in #86.
//   s-maxage=3600            — the CDN serves repeat fetches from the edge.
//   stale-while-revalidate   — an expired copy revalidates in the background
//                              instead of serializing invocations behind it.
//   max-age=0                — clients hold no copy, so changing an advertised
//                              endpoint propagates once the edge copy expires.
// Safe to share across callers because these responses contain nothing
// per-caller and CORS here is a static `*`, not a reflected Origin — so no
// Vary is needed and no caller's response can be replayed to another. Never
// put this on the MCP endpoint itself, whose responses are per-caller.
const DISCOVERY_CACHE_CONTROL =
  'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

function handleProtectedResourceMetadata(
  req: VercelRequest,
  res: VercelResponse
): void {
  const baseUrl = getBaseUrl(req);
  res.setHeader('Cache-Control', DISCOVERY_CACHE_CONTROL);
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
  res.setHeader('Cache-Control', DISCOVERY_CACHE_CONTROL);
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
 * metadata, and issue a signed client_id binding its exact redirect URIs.
 * Nothing is persisted; the token endpoint also checks this signed binding.
 */
function handleRegister(req: VercelRequest, res: VercelResponse): void {
  const body =
    req.body && typeof req.body === 'object'
      ? (req.body as Record<string, unknown>)
      : {};
  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris
    : [];
  if (
    redirectUris.length < 1 ||
    redirectUris.length > 5 ||
    !redirectUris.every(
      (uri) => typeof uri === 'string' && isRegistrationUriAllowed(uri)
    )
  ) {
    res.status(400).json({ error: 'invalid_redirect_uri' });
    return;
  }

  let clientId: string;
  try {
    clientId = registerClient(
      redirectUris as string[],
      typeof body.client_name === 'string' ? body.client_name : 'mcp-client'
    );
  } catch (error) {
    console.error('oauth_registration_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(503).json({ error: 'temporarily_unavailable' });
    return;
  }

  console.log('oauth_register', {
    clientName: body.client_name,
    redirectUris,
  });

  res.status(201).json({
    client_id: clientId,
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
    const clientId = requestUrl.searchParams.get('client_id');

    // Reject before doing anything: the authorization code redeems into a real
    // API key, so we only ever deliver it to an allowlisted redirect_uri.
    if (!isClientRedirectAllowed(clientId, redirectUri)) {
      console.warn('oauth_authorize_rejected_redirect_uri', { redirectUri });
      res.status(400).json({
        error: 'invalid_request',
        error_description:
          'redirect_uri is not allowed. It must be a registered client callback or a loopback address.',
      });
      return;
    }

    // Require the advertised S256 PKCE policy before issuing an authorization
    // code. This applies to every client; there is no legacy non-PKCE path.
    const pkceRequest = validatePkceAuthorization({
      codeChallenge,
      codeChallengeMethod,
    });
    if (!pkceRequest.ok) {
      console.warn('oauth_authorize_pkce_rejected');
      res.status(400).json({
        error: 'invalid_request',
        error_description: pkceRequest.error,
      });
      return;
    }

    // 1. Create a guest flash auth request. The PKCE challenge is persisted
    //    with it and verified when the separate authorization code is redeemed.
    const requestId = await createFlashAuthRequest(pkceRequest.codeChallenge);

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
    //    MCP completion endpoint with a separate code once approved.
    const innerParams = new URLSearchParams({
      request: requestId,
      redirect_uri: getCompletionUrl(),
      state: createHandoffState(requestId, redirectUri!, state ?? ''),
    });
    const innerRedirect = `/integrations/mcp/login?${innerParams.toString()}`;
    const handoffUrl = `${getConsoleBaseUrl()}/login?redirect=${encodeURIComponent(
      innerRedirect
    )}`;

    // Don't log the full handoff URL (it embeds the approval request ID).
    console.log('oauth_authorize_handoff', {
      consoleHost: new URL(getConsoleBaseUrl()).host,
      ...(VERBOSE ? { requestId } : {}),
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
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

function handleOAuthComplete(req: VercelRequest, res: VercelResponse): void {
  const url = new URL(req.url ?? '/', getBaseUrl(req));
  const code = url.searchParams.get('code');
  const handoff = readHandoffState(url.searchParams.get('state') ?? '');
  if (
    !code ||
    !/^[a-f0-9]{64}$/.test(code) ||
    !handoff ||
    handoff.requestId !== url.searchParams.get('request')
  ) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  const target = new URL(handoff.redirectUri);
  target.searchParams.set('code', code);
  if (handoff.state) target.searchParams.set('state', handoff.state);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.redirect(302, target.toString());
}

function handleOAuthHandoff(req: VercelRequest, res: VercelResponse): void {
  const url = new URL(req.url ?? '/', getBaseUrl(req));
  const requestId = url.searchParams.get('request');
  const handoff = readHandoffState(url.searchParams.get('state') ?? '');
  if (!handoff || handoff.requestId !== requestId) {
    res.status(400).json({ error: 'invalid_request' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ redirect_uri: handoff.redirectUri });
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
 * OAuth token endpoint. The client exchanges the separate authorization code
 * and PKCE verifier for a Runpod API key. The backend atomically consumes the
 * code after checking the verifier.
 */
async function handleToken(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  const params = new URLSearchParams(encodeBody(req.body));
  const code = params.get('code');
  const verifierRequest = validatePkceVerifier(params.get('code_verifier'));
  const redirectUri = params.get('redirect_uri');
  const clientId = params.get('client_id');

  if (params.get('grant_type') !== 'authorization_code') {
    tokenError(
      res,
      400,
      'unsupported_grant_type',
      'Only authorization_code is supported.'
    );
    return;
  }
  if (
    !code ||
    !/^[a-f0-9]{64}$/.test(code) ||
    !isClientRedirectAllowed(clientId, redirectUri)
  ) {
    tokenError(res, 400, 'invalid_grant', 'Invalid code or redirect URI.');
    return;
  }
  if (!verifierRequest.ok) {
    tokenError(res, 400, 'invalid_grant', verifierRequest.error);
    return;
  }

  try {
    const result = await flashGraphql<{ apiKey: string }>(
      `mutation { redeemFlashOAuthCode(authorizationCode: ${JSON.stringify(code)}, codeVerifier: ${JSON.stringify(verifierRequest.codeVerifier)}) { apiKey } }`,
      'redeemFlashOAuthCode'
    );
    res.status(200).json({ access_token: result.apiKey, token_type: 'Bearer' });
  } catch (error) {
    console.error('oauth_token_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    tokenError(
      res,
      400,
      'invalid_grant',
      'Authorization code is invalid, expired, or already used.'
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
      'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, X-Runpod-Analytics'
    );
    res.status(204).end();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  // WWW-Authenticate MUST be exposed: it is how a 401 tells an OAuth-capable
  // client to re-run its auth flow, and browsers hide every non-safelisted
  // response header from JavaScript unless it is listed here. Omitting it makes
  // the re-auth signal invisible to browser-based MCP clients.
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Mcp-Session-Id, Content-Type, WWW-Authenticate'
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

  if (req.method === 'GET' && pathname === '/oauth/complete') {
    handleOAuthComplete(req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/oauth/handoff') {
    handleOAuthHandoff(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/alp/submit') {
    await handleAlpSubmit(
      req as unknown as import('node:http').IncomingMessage & {
        body?: unknown;
      },
      res as unknown as import('node:http').ServerResponse
    );
    return;
  }

  if (req.method === 'POST' && pathname === '/api/alp/journal') {
    await handleAlpJournalRead(
      req as unknown as import('node:http').IncomingMessage & {
        body?: unknown;
      },
      res as unknown as import('node:http').ServerResponse
    );
    return;
  }

  if (req.method === 'POST' && pathname === '/api/search') {
    await handleSearch(
      req as unknown as import('node:http').IncomingMessage & {
        body?: unknown;
      },
      res as unknown as import('node:http').ServerResponse
    );
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
