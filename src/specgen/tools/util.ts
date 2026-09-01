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
    throw error;
  }
}
