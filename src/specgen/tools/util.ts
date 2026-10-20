// Shared helpers for curated tool handlers.

import { HttpError } from '../clients/http-error.js';
import type { ToolResult } from '../dispatch.js';

export function ok(payload: unknown): ToolResult {
  return { ok: true, status: 200, payload };
}

export function badRequest(message: string): ToolResult {
  return { ok: false, status: 400, payload: { error: message } };
}

// Runs a handler body and maps a thrown HttpError, request deadline or network
// failure onto a ToolResult; anything else propagates (a bug should fail
// loudly, not masquerade as an API error).
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const cause = (error as { cause?: unknown }).cause;
  return (
    cause instanceof Error &&
    (cause.name === 'TimeoutError' || cause.name === 'AbortError')
  );
}

// Failures where the request provably never left this machine or never reached
// Runpod: name resolution, connect, and TLS handshake. Anything else (a reset,
// a closed socket) can happen after the request was sent, so a write may have
// been applied upstream.
const UNREACHED_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const TLS_CODE = /^(?:CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

// The system/undici error code behind a `fetch failed`, if there is one.
// undici puts it on `cause`; happy-eyeballs connects wrap it in an
// AggregateError whose own code is set too.
function networkErrorCode(error: unknown): string | undefined {
  if (!(error instanceof TypeError) || error.message !== 'fetch failed')
    return undefined;
  const cause = (error as { cause?: unknown }).cause;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string') return code;
  const inner = cause instanceof AggregateError ? cause.errors[0] : undefined;
  const innerCode = (inner as { code?: unknown } | undefined)?.code;
  return typeof innerCode === 'string' ? innerCode : undefined;
}

function networkFailureResult(code: string): ToolResult {
  const unreached = UNREACHED_CODES.has(code) || TLS_CODE.test(code);
  return {
    ok: false,
    status: unreached ? 503 : 502,
    payload: unreached
      ? {
          error: 'Could not reach the Runpod API.',
          cause: code,
          hint: 'The request never reached Runpod, so nothing was changed: retry the same call once. If it fails again, the network, DNS, proxy or TLS setup on this machine is the likely cause; check https://uptime.runpod.io and report it rather than retrying further.',
        }
      : {
          error:
            'The connection to the Runpod API dropped before a response arrived.',
          cause: code,
          hint: 'The request may have been applied. A read can be retried once. For a create, update, delete or job submission, check with the matching get- or list- tool whether it took effect before calling again; retrying blindly can create a duplicate billable resource.',
        },
  };
}

export async function runTool(
  body: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        ok: false,
        status: error.status,
        payload: { error: error.message, detail: error.payload },
      };
    }
    // A request deadline firing (boundedFetch on the SDK/GraphQL/runtime paths,
    // or the SSE reader's own controller) must come back as a retryable tool error,
    // not a protocol-level crash. undici surfaces it either as the abort
    // reason itself (TimeoutError) or wrapped as `fetch failed` with a cause.
    if (isTimeout(error)) {
      return {
        ok: false,
        status: 504,
        payload: {
          error: 'The Runpod API did not respond before the request deadline.',
          hint: 'Transient upstream stall: retry the same call once; if it persists, check https://uptime.runpod.io.',
        },
      };
    }
    // A request that failed below HTTP (DNS, connect, TLS, a dropped socket)
    // is an environment failure the agent can act on, not a server bug, so it
    // comes back as a tool error too.
    const code = networkErrorCode(error);
    if (code) return networkFailureResult(code);
    throw error;
  }
}
