// Executes a generated tool call by mapping its arguments onto the SDK client:
// path params substitute into the URL template, query params pass through, and
// the optional "body" argument becomes the request body.

import type { RunpodClient } from '@runpod/sdk';
import type { GeneratedTool } from './generated/tools.gen.js';

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
  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  for (const param of tool.params) {
    if (args[param.name] === undefined) continue;
    if (param.location === 'path') pathParams[param.name] = args[param.name];
    else query[param.name] = args[param.name];
  }

  // openapi-fetch is typed per literal path; generated dispatch is generic by
  // construction, so the path/verb pair is asserted.
  const verb = tool.method as 'GET';
  const { data, error, response } = await (client as any)[verb](tool.path, {
    params: { path: pathParams, query },
    ...(tool.hasBody && args.body !== undefined ? { body: args.body } : {}),
  });

  if (error !== undefined)
    return { ok: false, status: response.status, payload: error };
  return {
    ok: true,
    status: response.status,
    payload: data ?? { status: response.status },
  };
}
