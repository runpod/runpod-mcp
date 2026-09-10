// Shared helpers for curated tool handlers.

import { HttpError } from '../clients/http-error.js';
import type { ToolResult } from '../dispatch.js';

export function ok(payload: unknown): ToolResult {
  return { ok: true, status: 200, payload };
}

export function badRequest(message: string): ToolResult {
  return { ok: false, status: 400, payload: { error: message } };
}

// Runs a handler body and maps a thrown HttpError onto a ToolResult; anything
// else propagates (a bug should fail loudly, not masquerade as an API error).
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const cause = (error as { cause?: unknown }).cause;
  return (
    cause instanceof Error &&
    (cause.name === 'TimeoutError' || cause.name === 'AbortError')
  );
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
    throw error;
  }
}
