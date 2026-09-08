// Executes a generated tool call by mapping its arguments onto the SDK client:
// path params substitute into the URL template, query params pass through, and
// the optional "body" argument becomes the request body.

import type { RunpodClient } from '@runpod/sdk';
import type { GeneratedTool } from './generated/tools.gen.js';
import { withRateLimitHint } from '../_shared/rate-limit.js';

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

  // Mirror of the check above, for the opposite mistake. Dispatch only reads
  // declared params, so an argument with a plausible-but-wrong name used to be
  // dropped in silence and the call still succeeded — asking for
  // `includeAvailability` (the v1 spelling) on list-gpu-types returned a 200
  // with no availability fields at all, which reads as "priced and in stock"
  // if you trust the request you thought you made. A wrong answer is worse
  // than an error, so name the unknown key and list what this tool accepts.
  const allowed = new Set(tool.params.map((p) => p.name));
  if (tool.hasBody) allowed.add('body');
  const unknown = Object.keys(args).filter((name) => !allowed.has(name));
  if (unknown.length) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: `Unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
        accepted: [...allowed],
      },
    };
  }

  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  for (const param of tool.params) {
    if (args[param.name] === undefined) continue;
    if (param.location === 'path') {
      pathParams[param.name] = args[param.name];
      continue;
    }
    const value = args[param.name];
    // `explode: false` in the spec means form style with ONE comma-joined
    // value. openapi-fetch's default serializer repeats the key per array
    // item instead, and upstream rejects that with "parameter 'x' is not
    // exploded, but is specified multiple times" — so a multi-value filter
    // fails while a single value passes, which is exactly the shape of bug
    // that survives casual testing.
    query[param.name] =
      param.explode === false && Array.isArray(value) ? value.join(',') : value;
  }

  // Some MCP clients serialize a nested object argument as a JSON string
  // rather than an object. Forwarding that verbatim makes upstream reject the
  // whole request with "$: got string, want object" — which never mentions
  // that the body was stringified, so the agent re-reads the schema it already
  // followed and retries the same shape. Accept the string and parse it; a
  // body that is not valid JSON is the client's error, so name it plainly.
  let body = args.body;
  if (tool.hasBody && typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return {
        ok: false,
        status: 400,
        payload: {
          error:
            'The body argument arrived as a string that is not valid JSON. Send body as an object.',
        },
      };
    }
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
    ...(tool.hasBody && body !== undefined ? { body } : {}),
  });

  // Branch on the RESPONSE, not on `error`: openapi-fetch returns
  // `{ error: undefined }` for a non-OK response with an empty body
  // (Content-Length: 0 — a WAF/edge answering a bare 429/403/502 does this),
  // and treating that as success would tell the agent a failed call worked
  // and bypass the 401 onUnauthorized gate.
  if (!response.ok) {
    const body =
      error !== undefined
        ? error
        : { error: response.statusText || `HTTP ${response.status}` };
    // A 429's bare "rate limit exceeded" invites an immediate retry; turn the
    // response's RateLimit/Retry-After headers into a concrete wait
    // instruction (ported from the pre-specgen server).
    const payload =
      response.status === 429
        ? withRateLimitHint(body, response.headers)
        : body;
    return { ok: false, status: response.status, payload };
  }
  return {
    ok: true,
    status: response.status,
    payload: data ?? { status: response.status },
  };
}
