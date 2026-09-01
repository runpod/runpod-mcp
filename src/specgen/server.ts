// MCP server wiring: the generated tool set plus the curated overlay, served
// over the low-level protocol Server so generated JSON Schemas pass through
// without a Zod round-trip.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './context.js';
import { dispatchGeneratedTool, type ToolResult } from './dispatch.js';
import { generatedTools } from './generated/tools.gen.js';
import { getCapacity } from './tools/capacity.js';
import { setEndpointGpus } from './tools/endpoint-gpus.js';
import { hubTools } from './tools/hub.js';
import { jobTools } from './tools/jobs.js';
import { listTemplates } from './tools/list-templates.js';
import { logTools } from './tools/logs.js';
import { listPublicEndpoints } from './tools/public-endpoints.js';
import { runTool } from './tools/util.js';
import { callerId, logToolCall, noopRateLimiter, type RateLimiter } from './ops.js';

export interface CuratedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (
    ctx: ToolContext,
    args: Record<string, unknown>
  ) => Promise<ToolResult>;
}

// The curated overlay: tools whose backing plane the v2 spec does not cover
// (Serverless runtime, GraphQL), plus targeted replacements for generated
// tools that need shaping (list-templates) or a non-JSON transport (the SSE
// log tools).
export const curatedTools: CuratedTool[] = [
  listTemplates,
  ...jobTools,
  ...logTools,
  getCapacity,
  ...hubTools,
  setEndpointGpus,
  listPublicEndpoints,
];

// Usage briefing delivered to connecting agents at initialize (the MCP
// `instructions` field). The official server ships one; agents without it
// tend to answer account questions from memory instead of calling tools.
// This block is the maintained EXCERPT of the answer contract; the canonical
// full text lives in skills/runpod/SKILL.md (the router skill). The rules the
// two must state alike are pinned by tests/instructions.test.ts.
export const SERVER_INSTRUCTIONS = `These tools cover the RunPod v2 REST surface: compute catalog (GPUs, CPUs, data centers, capacity), pods, serverless endpoints and jobs, templates, network volumes, container registries, billing, public endpoints, and the Hub.

Answer from live reads, as facts. Account and availability questions can only be answered from tool data: call the relevant list-/get- tool and quote the figures, names, and ids it returns verbatim. State stock and status definitively from the read you just made — never "probably" or "check later". When the user names a resource loosely ("my comfyui pod"), resolve it with a list- tool; ask only on genuine ambiguity. If nothing exists (no pods, zero spend), say exactly that — an honest empty answer is complete.

Commit; don't hedge, don't defer. Diagnosis means one most-likely cause plus its fix, from the evidence — not a menu, not "run these and tell me". For jobs, block server-side (runsync-endpoint and get-job-status accept wait, up to 300000 ms), expect first-job cold starts of minutes, and check worker states between holds; when a wait outlasts what the tools can hold, report the evidenced state — what was created, what was submitted, what the worker states show — and the recommended next step. Offering to keep watching is fine; stopping mid-wait without that report is not. Never claim success without the artifact that proves it (the transcript text, the output payload).

Mutations cost money and bind to what this conversation created. State the hourly price before creating anything billable, read before you mutate, and stop, update, or delete only resources your own tool calls created in this conversation — a name that looks like test junk is not attribution. For anything you cannot attribute, the complete answer is the audit: what you checked, what qualifies, the ids, and the exact actions for the user to take.

These tools manage infrastructure only. They do not do SSH sessions, file transfer to or from pods, local image builds, or interactive terminals — say plainly when a task needs one of those and name the real path (the RunPod console, runpodctl) instead of improvising.

The tool schemas are generated from the RunPod v2 OpenAPI contract, served as a machine-readable document at https://v2-rest.runpod.dev/v2/openapi.yaml — consult it for fields beyond the tool surface.`;

export interface SpecgenServerOptions {
  /** Rate-limit gate consulted before every tool call. Defaults to the no-op stub. */
  rateLimiter?: RateLimiter;
}

export function createSpecgenServer(
  ctx: ToolContext,
  version = '0.1.0',
  opts: SpecgenServerOptions = {}
): Server {
  const rateLimiter = opts.rateLimiter ?? noopRateLimiter;
  const caller = callerId(ctx.apiKey);
  const server = new Server(
    { name: 'Runpod API Server', version: `${version} [specgen]` },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...curatedTools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      ...generatedTools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Rate-limit seat: consulted before any tool work. The stub always admits;
    // a denial comes back as a retryable tool error, not a protocol failure.
    const verdict = await rateLimiter(caller, request.params.name);
    if (!verdict.allowed) {
      logToolCall({ tool: request.params.name, caller, ok: false, status: 429, durationMs: 0 });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Rate limited by this MCP server.',
              hint: `Pause${verdict.retryAfterS ? ` ~${verdict.retryAfterS}s` : ' briefly'}, then retry the same call.`,
            }),
          },
        ],
        isError: true,
      };
    }

    const startedAt = Date.now();
    const curated = curatedTools.find(
      (tool) => tool.name === request.params.name
    );
    // runTool here as well as inside the curated handlers: it maps an HttpError
    // raised outside a handler body — a missing API key when the SDK client is
    // first built (src/context.ts) — onto a 401 tool result instead of a
    // protocol-level crash.
    const result = await runTool(() =>
      curated
        ? curated.handler(ctx, args)
        : dispatchTool(request.params.name, args)
    );
    logToolCall({
      tool: request.params.name,
      caller,
      ok: result.ok,
      status: result.status,
      durationMs: Date.now() - startedAt,
    });

    // On errors, attach a recovery hint by status class — the bare-client
    // (no-skills) path self-corrects from these instead of dead-ending.
    const payload =
      !result.ok &&
      typeof result.payload === 'object' &&
      result.payload !== null
        ? {
            ...(result.payload as Record<string, unknown>),
            hint: errorHint(result.status),
          }
        : result.payload;
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      isError: !result.ok,
    };
  });

  function errorHint(status: number): string | undefined {
    if (status === 400 || status === 422)
      return "Input shape mismatch: check this tool's schema for required fields. For job payloads, the worker's release config defines the expected input object — fix the payload and retry; don't abandon the task.";
    if (status === 401) return 'The RunPod API key is missing or invalid.';
    if (status === 402 || status === 403)
      return "Account balance or permissions: check get-billing / the account's balance before retrying billable operations.";
    if (status === 404)
      return 'No such resource on this account: verify the id with the matching list- tool before retrying.';
    if (status === 429)
      return 'Rate limited: pause briefly, then retry the same call.';
    if (status >= 500)
      return 'Upstream RunPod error: retry once; if it persists, report it as an API-side failure.';
    return undefined;
  }

  async function dispatchTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const tool = generatedTools.find((candidate) => candidate.name === name);
    if (!tool)
      return {
        ok: false,
        status: 404,
        payload: { error: `unknown tool ${name}` },
      };
    return dispatchGeneratedTool(ctx.sdk, tool, args);
  }

  return server;
}
