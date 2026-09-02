// Executes a generated tool call by mapping its arguments onto the SDK client:
// path params substitute into the URL template, query params pass through, and
// the optional "body" argument becomes the request body.

import type { RunpodClient } from '@runpod/sdk';
import type { GeneratedTool } from './generated/tools.gen.js';
import { rateLimitHint } from '../_shared/rate-limit.js';

export interface ToolResult {
  ok: boolean;
  status: number;
  payload: unknown;
}

export async function dispatchGeneratedTool(
  client: RunpodClient,
  tool: GeneratedTool,
  args: Record<string, unknown>
): Promise<ToolResult> {
  // Fail loudly on a missing required argument. Without this, an unresolved
  // path placeholder reaches the API and comes back as a resource 404 ("gpu
  // type not found"), sending the agent off to re-verify an id that was never
  // sent. Checked from the generated schema, so it needs no per-tool code.
  const required = (tool.inputSchema.required ?? []) as string[];
  const missing = required.filter((name) => args[name] === undefined);
  if (missing.length) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
        expected: required,
        received: Object.keys(args),
      },
    };
  }

  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  for (const param of tool.params) {
    if (args[param.name] === undefined) continue;
    if (param.location === 'path') pathParams[param.name] = args[param.name];
    else query[param.name] = args[param.name];
  }

  // openapi-fetch is typed per literal path; generated dispatch is generic by
  // construction, so the client is narrowed to the structural shape of a verb
  // call rather than asserted to any.
  type VerbCall = (
    path: string,
    init: Record<string, unknown>
  ) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
  const verbs = client as unknown as Record<string, VerbCall>;
  const { data, error, response } = await verbs[tool.method](tool.path, {
    params: { path: pathParams, query },
    ...(tool.hasBody && args.body !== undefined ? { body: args.body } : {}),
  });

  if (error !== undefined) {
    // A 429's bare "rate limit exceeded" invites an immediate retry; turn the
    // response's RateLimit/Retry-After headers into a concrete wait
    // instruction (ported from the pre-specgen server).
    const payload =
      response.status === 429 && typeof error === 'object' && error !== null
        ? {
            ...(error as Record<string, unknown>),
            hint: rateLimitHint(
              response.headers.get('ratelimit'),
              response.headers.get('retry-after')
            ),
          }
        : error;
    return { ok: false, status: response.status, payload };
  }
  return {
    ok: true,
    status: response.status,
    payload: data ?? { status: response.status },
  };
}
