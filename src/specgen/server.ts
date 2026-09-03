// MCP server wiring: the generated tool set plus the curated overlay, served
// over the low-level protocol Server so generated JSON Schemas pass through
// without a Zod round-trip.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './context.js';
import { dispatchGeneratedTool, type ToolResult } from './dispatch.js';
import { generatedTools } from './generated/tools.gen.js';
import { skillDocs } from './generated/skills.gen.js';
import { getCapacity } from './tools/capacity.js';
import { setEndpointGpus } from './tools/endpoint-gpus.js';
import { hubTools } from './tools/hub.js';
import { jobTools } from './tools/jobs.js';
import { listEndpoints } from './tools/list-endpoints.js';
import { listTemplates } from './tools/list-templates.js';
import { logTools } from './tools/logs.js';
import { listPublicEndpoints } from './tools/public-endpoints.js';
import { runTool } from './tools/util.js';
import { STATUS_WAIT_MAX_MS } from './tools/jobs.js';
import { SERVER_NAME } from '../server.js';
import { captureToolCall } from './analytics.js';
import { createAlpTools, type AlpToolsOptions } from './tools/alp.js';
import {
  callerId,
  logToolCall,
  noopRateLimiter,
  type RateLimiter,
} from './ops.js';

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
  listEndpoints,
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
export const SERVER_INSTRUCTIONS = `These tools cover the Runpod v2 REST surface: compute catalog (GPUs, CPUs, data centers, capacity), pods, serverless endpoints and jobs, templates, network volumes, container registries, billing, public endpoints, and the Hub.

Answer from live reads, as facts. Account and availability questions can only be answered from tool data: call the relevant list-/get- tool and quote the figures, names, and ids it returns verbatim. State stock and status definitively from the read you just made — never "probably" or "check later". When the user names a resource loosely ("my comfyui pod"), resolve it with a list- tool; ask only on genuine ambiguity. If nothing exists (no pods, zero spend), say exactly that — an honest empty answer is complete.

Commit; don't hedge, don't defer. Diagnosis means one most-likely cause plus its fix, from the evidence — not a menu, not "run these and tell me". For jobs, block server-side (runsync-endpoint and get-job-status accept wait, up to ${STATUS_WAIT_MAX_MS} ms), expect first-job cold starts of minutes, and check worker states between holds; when a wait outlasts what the tools can hold, report the evidenced state — what was created, what was submitted, what the worker states show — and the recommended next step. Offering to keep watching is fine; stopping mid-wait without that report is not. Never claim success without the artifact that proves it (the transcript text, the output payload).

Mutations cost money and bind to what this conversation created. State the hourly price before creating anything billable, read before you mutate, and stop, update, or delete only resources your own tool calls created in this conversation — a name that looks like test junk is not attribution. For anything you cannot attribute, the complete answer is the audit: what you checked, what qualifies, the ids, and the exact actions for the user to take.

These tools manage infrastructure only. They do not do SSH sessions, file transfer to or from pods, local image builds, or interactive terminals — say plainly when a task needs one of those and name the real path (the Runpod console, runpodctl) instead of improvising.

SKILLS — READ BEFORE ACTING. This server publishes its task playbooks as MCP resources under runpod://skills/. Before the FIRST Runpod tool call of a session, read runpod://skills/runpod (the router): it maps the request to a journey skill — deploying an endpoint reads runpod://skills/serverless-deploy, diagnosing a broken pod reads runpod://skills/pod-doctor, cost questions read runpod://skills/cost-audit, and so on — and each journey skill carries the procedure, pitfalls, and report format for that task. A reply produced without the routed skill loaded is out of contract. List them all with resources/list.

The tool schemas are generated from the Runpod v2 OpenAPI contract, served as a machine-readable document at https://api.runpod.io/v2/openapi.json — consult it for fields beyond the tool surface.`;

// Appended to the initialize briefing only when the ALP tools are enabled.
const ALP_INSTRUCTIONS = `

CONTRIBUTE WHAT YOU LEARN. Three write-only tools feed Runpod's agent-learning pipeline: report_feedback (something misbehaved or surprised you), save_to_journal (a reusable lesson about using Runpod), ask_question (you were stuck and the tools/skills/docs had no answer). Use them at the moment the observation happens, not at the end. They store data for Runpod to review — nothing is returned or answered today, and ask_question in particular NEVER produces an answer, so never wait on it. Never include API keys or secrets in submissions.`;

export interface SpecgenServerOptions {
  /** Rate-limit gate consulted before every tool call. Defaults to the no-op stub. */
  rateLimiter?: RateLimiter;
  /** Anonymous per-tool-call analytics (hosted path only — stdio never sets
   *  this, and captureToolCall itself is a no-op without POSTHOG_API_KEY).
   *  See src/specgen/analytics.ts for the privacy contract. */
  analytics?: {
    transport: 'stdio' | 'http';
    serverVersion: string;
    /** Sanitized client token (never a raw header). */
    clientName?: string;
    /** Stable account id from the credential pre-flight (myself.id) — the
     *  preferred identity source; hashed before it leaves the process. */
    accountId?: string;
  };
  /** Called when a tool result is a 401: the hosted path uses it to drop the
   *  cached credential verdict so the NEXT request re-checks and can emit the
   *  HTTP 401 that makes OAuth clients re-authenticate. */
  onUnauthorized?: () => void;
  /** ALP write tools (report_feedback / save_to_journal / ask_question).
   *  Enablement follows configuration: when absent, the tools do not appear
   *  in tools/list at all. See docs/agent-learning-protocol.md. */
  alp?: AlpToolsOptions;
}

export function createSpecgenServer(
  ctx: ToolContext,
  version = '0.1.0',
  opts: SpecgenServerOptions = {}
): Server {
  const rateLimiter = opts.rateLimiter ?? noopRateLimiter;
  const caller = callerId(ctx.apiKey);
  // The served curated set: the static surface plus the config-gated ALP
  // write tools. Everything downstream (list, routing) reads this, so a
  // disabled ALP is truly absent, not present-and-failing.
  const servedCuratedTools = opts.alp
    ? [...curatedTools, ...createAlpTools(opts.alp)]
    : curatedTools;
  const server = new Server(
    { name: SERVER_NAME, version: `${version} [specgen]` },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: opts.alp
        ? SERVER_INSTRUCTIONS + ALP_INSTRUCTIONS
        : SERVER_INSTRUCTIONS,
    }
  );

  // The stdio transport only learns which client is driving from the MCP
  // initialize handshake — feed it into the outbound tracking User-Agent
  // (the hosted path already resolves identity from the inbound UA).
  server.oninitialized = () => {
    const clientInfo = server.getClientVersion();
    if (clientInfo?.name) {
      ctx.setClientInfo?.(clientInfo.name, clientInfo.version);
      // ALP submissions attribute the harness the same way the tracking UA
      // does; the ALP tools read opts.alp at call time, so this late bind
      // reaches them.
      if (opts.alp) {
        opts.alp.harness = clientInfo.version
          ? `${clientInfo.name}/${clientInfo.version}`
          : clientInfo.name;
        opts.alp.harnessSource = 'client_info';
      }
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...servedCuratedTools.map(({ name, description, inputSchema }) => ({
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

  const SKILL_URI_PREFIX = 'runpod://skills/';

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: skillDocs.map((skill) => ({
      uri: `${SKILL_URI_PREFIX}${skill.name}`,
      name: skill.name,
      title: `Runpod skill: ${skill.name}`,
      description: skill.description,
      mimeType: 'text/markdown',
    })),
  }));

  // Some clients probe templates unconditionally; answer empty instead of -32601.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const name = request.params.uri.startsWith(SKILL_URI_PREFIX)
      ? request.params.uri.slice(SKILL_URI_PREFIX.length)
      : undefined;
    const skill = skillDocs.find((candidate) => candidate.name === name);
    if (!skill) {
      throw new Error(
        `Unknown resource ${request.params.uri}. Available: ${skillDocs
          .map((candidate) => `${SKILL_URI_PREFIX}${candidate.name}`)
          .join(', ')}`
      );
    }
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: 'text/markdown',
          text: skill.text,
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // Rate-limit seat: consulted before any tool work. The stub always admits;
    // a denial comes back as a retryable tool error, not a protocol failure.
    const verdict = await rateLimiter(caller, request.params.name);
    if (!verdict.allowed) {
      logToolCall({
        tool: request.params.name,
        caller,
        ok: false,
        status: 429,
        durationMs: 0,
      });
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
    const curated = servedCuratedTools.find(
      (tool) => tool.name === request.params.name
    );
    // runTool here as well as inside the curated handlers: it maps an HttpError
    // raised outside a handler body — a missing API key when the SDK client is
    // first built (src/specgen/context.ts) — onto a 401 tool result instead of a
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
    if (opts.analytics) {
      captureToolCall(ctx.apiKey, {
        tool: request.params.name,
        ok: result.ok,
        status: result.status,
        durationMs: Date.now() - startedAt,
        ...opts.analytics,
      });
    }
    // A 401 from the API proves a cached "valid" credential verdict wrong
    // before its TTL — let the shell drop it.
    if (!result.ok && result.status === 401) opts.onUnauthorized?.();

    // On errors, attach a recovery hint by status class — the bare-client
    // (no-skills) path self-corrects from these instead of dead-ending. A hint
    // already on the payload wins: dispatch/runtime derive precise 429 wait
    // instructions from the response headers, and the generic "pause briefly"
    // text must not clobber them.
    const payload =
      !result.ok &&
      typeof result.payload === 'object' &&
      result.payload !== null
        ? {
            ...(result.payload as Record<string, unknown>),
            hint:
              (result.payload as Record<string, unknown>).hint ??
              // runTool nests an HttpError's payload under `detail` — the
              // runtime client's header-derived 429 hint lives there.
              ((result.payload as { detail?: { hint?: string } }).detail ?? {})
                .hint ??
              errorHint(result.status),
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
    if (status === 401) return 'The Runpod API key is missing or invalid.';
    if (status === 402 || status === 403)
      return "Account balance or permissions: check get-billing / the account's balance before retrying billable operations.";
    if (status === 404)
      return 'No such resource on this account: verify the id with the matching list- tool before retrying.';
    if (status === 429)
      return 'Rate limited: pause briefly, then retry the same call.';
    if (status >= 500)
      return 'Upstream Runpod error: retry once; if it persists, report it as an API-side failure.';
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
