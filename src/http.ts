import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { registerTools, type ToolContext } from './tools.js';
import {
  createCredentialChecker,
  type CredentialChecker,
  type CredentialCheckerHandle,
} from './_shared/credential-check.js';
import {
  restV1Base,
  restV2Base,
  serverlessBase,
  authedGraphqlBase,
  type Env,
} from './_shared/backend.js';
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
  error: string,
  // A credential was supplied and rejected, as opposed to none being sent. RFC
  // 6750 §3.1 puts error="invalid_token" on that case and requires it be omitted
  // otherwise, so a client can tell "never authenticated" from "re-authenticate".
  invalidToken = false
): void {
  // Always advertise the protected-resource metadata so OAuth-capable clients
  // (e.g. Claude) know to start the "Sign in with Runpod" flow.
  const challenge = [
    'Bearer realm="mcp"',
    ...(invalidToken
      ? [
          'error="invalid_token"',
          'error_description="The credential was rejected; re-authenticate."',
        ]
      : []),
    `resource_metadata="${getBaseUrl(
      req
    )}/.well-known/oauth-protected-resource"`,
  ].join(', ');

  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': challenge,
  });
  res.end(JSON.stringify({ error }));
}

// The GraphQL host the pre-flight authenticates against. This call carries the
// CALLER'S key, so it uses authedGraphqlBase (RUNPOD_AUTHED_GRAPHQL_URL) — the
// variable backend.ts reserves for key-bearing GraphQL — NOT the freely
// repointable OAuth flash-auth var (RUNPOD_GRAPHQL_URL): repointing that one
// must never redirect every caller's key to an arbitrary host. One resolver so
// the checker and the environment guard below cannot disagree about defaults.
function authGraphqlUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>
): string {
  return authedGraphqlBase(env as Env);
}

// Shared across requests so the verdict cache helps on a warm instance. Uses the
// global fetch (Node >= 18) — this runs before any MCP/tool wiring exists.
export const defaultCredentialChecker: CredentialCheckerHandle =
  createCredentialChecker({
    fetch: (url, init) => fetch(url, init),
    url: () => authGraphqlUrl(process.env),
  });

const sameHost = (a: string, b: string) => normalizeUrl(a) === normalizeUrl(b);

// Hosts that are the same backend under a different name. `v2-rest.runpod.io`
// served as the REST v2 default before `api.runpod.io` became canonical, and a
// deployment that pinned it back then must not read as "REST moved" — that
// disagreement with the (unmoved) GraphQL host would silently switch the
// pre-flight off. Prod pair only: `v2-rest.runpod.dev` is genuinely a different
// environment and must NOT normalize into prod.
const HOST_ALIASES: Record<string, string> = {
  'v2-rest.runpod.io': 'api.runpod.io',
};

// Lowercased origin + path with any trailing slash removed, so cosmetic
// differences in an env var do not read as a different environment.
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.host.toLowerCase();
    return `${u.protocol}//${HOST_ALIASES[host] ?? host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return raw.trim().toLowerCase().replace(/\/+$/, '');
  }
}

// The pre-flight checks the token against RUNPOD_AUTHED_GRAPHQL_URL; the tools
// authenticate against the REST/Serverless hosts. Those are independent, so a
// deployment pointing REST at a dev environment while GraphQL stays on prod
// would validate a dev key against prod and reject EVERY request — though every
// tool would have worked. Skipping on that ambiguity is the safer error: a wrong
// 401 rejects everything, a missed one only restores the prior behaviour.
//
// UNVERIFIED: nobody has confirmed what the hosted deployment actually sets.
// There is no .env in the repo, no `env` block in vercel.json, and CI sets no
// RUNPOD_* vars — the values live only in the Vercel dashboard. If production
// points any REST host somewhere non-default without also setting
// RUNPOD_AUTHED_GRAPHQL_URL, this guard is silently disabling the gate in production
// right now. Run `vercel env ls production` to settle it.
function credentialCheckMayBeWrongEnvironment(env = process.env): boolean {
  // Normalised, not byte-exact: a trailing slash, host casing or an empty string
  // is not a different environment. Empty is treated as unset, matching how the
  // base URLs resolve.
  const envWithoutEmpties = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== '')
  ) as Record<string, string | undefined>;
  const restMoved =
    !sameHost(restV1Base(envWithoutEmpties), restV1Base({})) ||
    !sameHost(restV2Base(envWithoutEmpties), restV2Base({})) ||
    !sameHost(serverlessBase(envWithoutEmpties), serverlessBase({}));
  const graphqlMoved = !sameHost(authGraphqlUrl(env), authGraphqlUrl({}));
  // Skip whenever REST and the auth-GraphQL host DISAGREE about whether they are
  // on the default (prod) environment — in EITHER direction. Validating a key
  // against an auth backend from a different environment than the tools use
  // rejects every request while every tool would have worked, and OAuth clients
  // answer that 401 by re-authenticating in a loop. Only when both sides agree
  // (both default, or both moved) is the pre-flight validating against the same
  // environment the tools will call. An earlier version only caught REST-moved-
  // but-GraphQL-default, so moving only RUNPOD_GRAPHQL_URL (its documented dev
  // override) still 401'd every good credential.
  return restMoved !== graphqlMoved;
}

// Requires `method`, so a JSON-RPC *response* ({jsonrpc, id, result}) does not
// qualify — a client posting one invokes no tool, so there is no credential to
// check. Erring toward "skip" only loses a 401 we did not need.
function looksLikeMcpMessage(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const msg = value as { jsonrpc?: unknown; method?: unknown };
  return msg.jsonrpc === '2.0' && typeof msg.method === 'string';
}

// On a host that pre-parses bodies, `undefined` means the platform declined to
// parse this content type (Vercel returns undefined for everything outside
// json/text/urlencoded/octet-stream), so the body is unverifiable and must not be
// treated as MCP — otherwise a caller reopens the credential oracle by changing
// one header. On a host that never parses (plain node:http), there is nothing to
// inspect without consuming the stream the SDK needs, so the gate is skipped.
// Either way `undefined` is NOT checkable; only an actual MCP body is.
//
// `some`, not `every`: a JSON-RPC batch may legitimately mix a response element
// (no `method`) with a request that invokes a tool. `every` let one response
// element mark the whole batch un-checkable while the SDK still ran the tool
// call — a one-element opt-out of the pre-flight. If any element invokes a
// method, the batch must be checked. `some` on an empty array is false, so an
// empty batch (which invokes nothing) is correctly not checkable.
export function bodyIsCheckable(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some(looksLikeMcpMessage);
}

// The gate must be at least as permissive as the SDK's own content-type check,
// or any type the SDK accepts but the gate rejects is a bypass window: the gate
// skips, then the SDK parses and runs the tool with an unverified credential.
// The SDK uses `ct.includes('application/json')` (streamableHttp.js), so
// `application/json-patch+json` and `application/jsonx` reach a tool — an exact
// match here missed them. Mirror the SDK's substring test (lowercased, so the
// gate is a superset and stays safe even if the SDK never normalises case). A
// type the SDK 415s that we happen to check only costs one needless probe.
function isJsonContentType(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'];
  if (!ct) return false;
  return ct.toLowerCase().includes('application/json');
}

// Match the SDK's own body limit (MAXIMUM_MESSAGE_SIZE, '4mb'). A body the SDK
// would reject as too large is one we must not buffer either.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// readJsonBody's distinct "over the cap" result, kept separate from undefined
// (absent/unparseable) so the caller answers 413 rather than falling through to
// the skip path and handing a partial stream back to the SDK.
const BODY_TOO_LARGE = Symbol('body_too_large');

// Buffer and parse a JSON body when the host did not already. Without this the
// gate cannot run on a plain node:http host — the published ./http export and
// scripts/serve-http.local.ts — because there is nothing to inspect, which would
// silently disable the pre-flight for those consumers. The parsed value is handed
// to transport.handleRequest afterwards, so the SDK never needs the stream this
// consumed. Returns undefined when the body is absent or not JSON (the caller
// then skips), or BODY_TOO_LARGE past the cap (the caller answers 413).
//
// Capped, and only ever called after the cheap skip checks pass, so a non-JSON,
// kill-switched or oversized request never buffers: on the un-pre-parsed
// node:http path this replaces the SDK's own getRawBody, which enforced the same
// 4mb limit — without the cap an unauthenticated caller could stream unbounded
// bytes into memory, and reading before the content-type check let a slow
// non-JSON upload hold the request slot open.
async function readJsonBody(
  req: IncomingMessage
): Promise<unknown | typeof BODY_TOO_LARGE> {
  const existing = (req as { body?: unknown }).body;
  if (existing !== undefined) return existing;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return BODY_TOO_LARGE;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      // Covers a chunked upload or a lying Content-Length: stop the moment the
      // bytes on the wire exceed the cap, before growing the buffer further.
      if (total > MAX_BODY_BYTES) return BODY_TOO_LARGE;
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

type SkipReason =
  | 'skip_env_var'
  | 'skip_env_mismatch'
  | 'skip_not_post'
  | 'skip_not_json'
  | 'skip_not_mcp_body';

// Body-independent skip reasons, decided before the body is read (see
// readJsonBody). Only well-formed MCP POSTs are ever checked. This does NOT close
// the credential oracle — a caller who speaks the protocol still learns
// 401-vs-otherwise from a well-formed tools/list — but it stops an
// unauthenticated scanner probing stolen keys through us with arbitrary requests,
// and avoids an upstream query per junk request. Closing it properly needs rate
// limiting, which this does not add. GET and DELETE make no authenticated
// upstream call, so a dead credential breaks nothing there. The cheap header
// checks precede the env-mismatch scan (which parses several URLs) so the common
// non-POST path stays cheap, and the kill switch comes first so it also prevents
// the body read.
function earlyCredentialCheckSkip(req: IncomingMessage): SkipReason | null {
  if (process.env.MCP_SKIP_CREDENTIAL_CHECK === 'true') return 'skip_env_var';
  if (req.method !== 'POST') return 'skip_not_post';
  if (!isJsonContentType(req)) return 'skip_not_json';
  if (credentialCheckMayBeWrongEnvironment()) return 'skip_env_mismatch';
  return null;
}

// The ToolContext the hosted path hands to registerTools. Exported so the
// onUnauthorized wiring is reachable from a test.
export function buildToolContext(
  req: IncomingMessage,
  bearerToken: string,
  opts: {
    serverVersion?: string;
    invalidateCredential?: (token: string) => void;
  } = {}
): ToolContext {
  const drop = opts.invalidateCredential ?? defaultCredentialChecker.invalidate;
  return {
    apiKey: bearerToken,
    transport: 'http',
    // A tools/call is a separate request from `initialize` in stateless HTTP, so
    // the per-request server never sees the MCP `clientInfo`; fall back to the
    // inbound User-Agent so caller-tracking still attributes the client.
    clientUserAgent: req.headers['user-agent'],
    serverVersion: opts.serverVersion,
    // A tool call that 401s proves a cached "valid" wrong before its TTL. Drop it
    // so the next request re-checks and can emit the 401 that triggers re-auth.
    onUnauthorized: () => drop(bearerToken),
  };
}

function logCredentialCheck(
  outcome: SkipReason | 'pass' | 'reject' | 'fail_open'
): void {
  // 'pass' is the bulk of traffic and is pure log spend; everything else —
  // rejections, fail-open guesses, every skip reason — always logs, because those
  // are the only way to notice the gate misbehaving or silently not running.
  if (outcome === 'pass' && process.env.MCP_VERBOSE_LOGS !== 'true') return;
  console.log('credential_check', { outcome });
}

/**
 * Handle an incoming HTTP request as a streamable MCP session.
 *
 * Each request gets its own McpServer + transport. The caller's Bearer token
 * is forwarded directly to the Runpod API as the credential — it may be a
 * Runpod API key (set manually by the caller) or a token obtained through the
 * OAuth "Sign in with Runpod" flow. The server holds no credential of its own
 * and never shares one across users.
 *
 * The token is pre-flight verified (cached) before the MCP request is
 * handled: a dead credential — e.g. an OAuth-minted key revoked mid-session —
 * must surface as an HTTP 401 + WWW-Authenticate so
 * OAuth-capable clients re-run their auth flow automatically. Without this,
 * the upstream 401 is wrapped into a 200 JSON-RPC tool error and the client
 * never re-authenticates. Set MCP_SKIP_CREDENTIAL_CHECK=true to disable.
 *
 * The gate also self-disables when the REST hosts are overridden without a
 * matching RUNPOD_AUTHED_GRAPHQL_URL — see credentialCheckMayBeWrongEnvironment.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    serverVersion?: string;
    // Test seams — production uses the shared default checker.
    verifyCredential?: CredentialChecker;
    invalidateCredential?: (token: string) => void;
  } = {}
): Promise<void> {
  const bearerToken = extractBearerToken(req);
  console.log('mcp_request', {
    method: req.method,
    url: req.url,
    hasBearerToken: !!bearerToken,
  });
  // Stateless server: there are no server-initiated messages, so the standalone
  // GET SSE stream has nothing to carry. Per spec, answer 405 instead of letting
  // the SDK hold an idle stream open until the platform kills it.
  if (req.method === 'GET') {
    res.writeHead(405, {
      Allow: 'POST, DELETE',
      'Content-Type': 'application/json',
    });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message:
            'Method Not Allowed: this server does not offer a standalone SSE stream.',
        },
        id: null,
      })
    );
    return;
  }
  if (!bearerToken) {
    writeUnauthorized(
      req,
      res,
      'Missing or invalid Authorization header. Provide a Bearer token.'
    );
    return;
  }

  // The body is read only when the pre-flight might actually run. The cheap,
  // body-independent skips are decided first (earlyCredentialCheckSkip) so a
  // non-JSON, kill-switched or wrong-environment request never buffers a body —
  // an earlier version read every body up front, which removed the SDK's 4mb cap
  // and let a slow or oversized non-JSON upload hold the request slot open. For a
  // skipped request `body` stays whatever the host pre-parsed (undefined on plain
  // node:http, where the SDK then reads the stream itself).
  let body: unknown = (req as { body?: unknown }).body;
  const early = earlyCredentialCheckSkip(req);
  if (early) {
    logCredentialCheck(early);
  } else {
    const read = await readJsonBody(req);
    if (read === BODY_TOO_LARGE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large.' }));
      return;
    }
    body = read;
    if (!bodyIsCheckable(body)) {
      // Absent, unparseable, or not an MCP message — nothing to check, and
      // checking it anyway would reopen the credential oracle.
      logCredentialCheck('skip_not_mcp_body');
    } else {
      const verify = opts.verifyCredential ?? defaultCredentialChecker.verify;
      const verdict = await verify(bearerToken);
      // 'unknown' is logged distinctly from 'pass': both let the request through,
      // but one is an answer and the other a guess made because the auth backend
      // could not be reached. Silently merging them hides an outage upstream.
      logCredentialCheck(
        verdict.status === 'invalid'
          ? 'reject'
          : verdict.status === 'valid'
            ? 'pass'
            : 'fail_open'
      );
      if (verdict.status === 'invalid') {
        writeUnauthorized(
          req,
          res,
          `${verdict.reason} Re-authenticate to continue.`,
          true
        );
        return;
      }
    }
  }

  const server = createServer(opts.serverVersion);
  registerTools(server, buildToolContext(req, bearerToken, opts));

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
  // Pass the body we already resolved: readJsonBody may have consumed the stream.
  await transport.handleRequest(req, res, body);
}

export { registerTools } from './tools.js';
export type { ToolContext } from './tools.js';
