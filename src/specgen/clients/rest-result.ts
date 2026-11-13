import type { ToolResult } from '../dispatch.js';
import { withRateLimitHint } from '../../_shared/rate-limit.js';

/** Preserve status even when the API error has no body; attach quota guidance.
 *
 *  The payload always carries the upstream HTTP `status` (a number): a client
 *  reads it to tell a Runpod 401/429 from an MCP-side failure, and an empty or
 *  non-JSON body (an edge answering a bare 403/429, an empty 401) would
 *  otherwise reach it as `{ error }` alone. A body that already has a status
 *  (REST v2 ErrorResponse) keeps its own shape. */
export function restError(response: Response, error: unknown): ToolResult {
  const payload = withStatus(error, response);
  return {
    ok: false,
    status: response.status,
    payload:
      response.status === 429
        ? withRateLimitHint(payload, response.headers)
        : payload,
  };
}

function withStatus(error: unknown, response: Response): unknown {
  const { status } = response;
  if (error === undefined || error === null || error === '') {
    return { error: response.statusText || `HTTP ${status}`, status };
  }
  if (typeof error !== 'object' || Array.isArray(error)) {
    return { error, status };
  }
  const body = error as Record<string, unknown>;
  const detail = body.detail;
  const detailHasStatus =
    detail !== null &&
    typeof detail === 'object' &&
    'status' in (detail as Record<string, unknown>);
  return 'status' in body || detailHasStatus ? body : { ...body, status };
}
