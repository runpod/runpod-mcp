// ALP tools (Agent Learning Protocol): report_feedback, save_to_journal,
// ask_question write; read_journal reads back the caller's own journal. See
// docs/agent-learning-protocol.md, "The tool pair".
//
// All four are thin clients of the hosted endpoints (POST /api/alp/submit and
// POST /api/alp/journal) — the npm package holds no storage credentials, so
// both transports go there with the caller's own key. The journal is the ONE
// route that is served back, and only to the identity that wrote it; feedback
// and questions return nothing, and every description and response says so
// honestly — an ambiguous ack is a false affordance the model may plan around
// (waiting, polling, re-asking).
//
// FAIL-SOFT: these tools are side quests. Whatever goes wrong, the result is
// a calm non-error saying the entry was not recorded and not to retry —
// never a tool failure that derails the agent's actual task.

import type { AlpRoute } from '../../alp/ingest.js';
import {
  clampLimit,
  DEFAULT_JOURNAL_LIMIT,
  MAX_JOURNAL_LIMIT,
  type JournalEntry,
} from '../../alp/read.js';
import type { ToolContext } from '../context.js';
import type { CuratedTool } from '../server.js';
import { ok } from './util.js';

// HOSTED-ONLY by decision (2026-09-03): src/http.ts registers these tools
// whenever the deployment configures its sink (ALP_SINK_URL + ALP_SINK_SECRET);
// the stdio entrypoint never does, so local users cannot enable them. Absent
// from tools/list is the disabled state — absent is unambiguous and free,
// present-but-failing costs context and invites retries.

const NOT_RECORDED =
  'The entry was NOT recorded. Do not retry — continue your task.';

async function submit(
  ctx: ToolContext,
  ingestUrl: string,
  route: AlpRoute,
  args: Record<string, unknown>,
  extra: {
    transport: 'stdio' | 'http';
    harness?: string;
    harnessSource?: string;
  }
): Promise<{ recorded: boolean }> {
  try {
    const response = await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
      },
      body: JSON.stringify({
        route,
        content: args.content,
        intention: args.intention,
        modelType: args.modelType,
        severity: args.severity,
        tool: args.tool,
        workaround: args.workaround,
        trigger: args.trigger,
        ...extra,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      recorded?: boolean;
    };
    return { recorded: response.ok && body.recorded === true };
  } catch {
    return { recorded: false };
  }
}

// The read endpoint sits beside the write endpoint on the same deployment.
// Derived, not configured, so the two can never point at different servers.
export function journalReadUrl(ingestUrl: string): string {
  return ingestUrl.replace(/\/submit$/, '/journal');
}

async function readJournal(
  ctx: ToolContext,
  readUrl: string,
  limit: number
): Promise<{ available: boolean; entries: JournalEntry[] }> {
  try {
    const response = await fetch(readUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}),
      },
      // Only the page size crosses the wire. Whose journal this is comes from
      // the Bearer token, resolved server-side — there is no argument for it.
      body: JSON.stringify({ limit }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      available?: boolean;
      entries?: unknown;
    };
    if (
      !response.ok ||
      body.available !== true ||
      !Array.isArray(body.entries)
    ) {
      return { available: false, entries: [] };
    }
    return { available: true, entries: body.entries as JournalEntry[] };
  } catch {
    return { available: false, entries: [] };
  }
}

// Shared input schema. `content` stays the only required field — fewer required
// args means a higher call-through rate (design doc, Fields) — and everything
// added since is optional and mechanical, answerable from what the agent
// already did rather than from fresh reasoning.
//
// The first 21 production submissions showed prose was never the shortfall:
// 233-1794 characters each, `intention` filled on 20 of 21, several tracing a
// contradiction across five paired reads. What was missing was any dimension to
// sort or route them by, so a total blocker sat beside a docs nit and telling
// them apart meant opening both. Hence structure, not longer prose.
const SEVERITY = ['blocked', 'degraded', 'cosmetic'] as const;

const TOOL_FIELD = {
  type: 'string' as const,
  description:
    'The name of the tool this is about, exactly as it appears in your tool list (for example create-pod). Omit only when no single tool is involved.',
};

const alpInputSchema = (
  contentDescription: string,
  extra: Record<string, unknown> = {}
) => ({
  type: 'object' as const,
  properties: {
    content: {
      type: 'string' as const,
      description: contentDescription,
    },
    intention: {
      type: 'string' as const,
      description:
        'One short sentence: what you were trying to accomplish when this came up.',
    },
    ...extra,
    modelType: {
      type: 'string' as const,
      description:
        'Your best identification of the model you are running as, and the product running it if you know that too — for example "Claude Opus 5 in Claude Code", "GPT-5.6 via Codex", "Grok 4.6 in Cursor". Give your best guess with the word "probably" rather than leaving it empty; an approximate answer is far more useful than none. Optional.',
    },
  },
  required: ['content'],
});

export interface AlpToolsOptions {
  ingestUrl: string;
  transport: 'stdio' | 'http';
  harness?: string;
  harnessSource?: 'client_info' | 'user_agent';
}

export function createAlpTools(opts: AlpToolsOptions): CuratedTool[] {
  // Read from `opts` at CALL time, not creation time: on stdio the harness
  // (MCP clientInfo) only arrives with the initialize handshake, after these
  // tools are built — the server updates opts.harness then.
  const extra = () => ({
    transport: opts.transport,
    harness: opts.harness,
    harnessSource: opts.harnessSource,
  });

  const reportFeedback: CuratedTool = {
    // FAIL-SOFT applies to the argument gate too: a misnamed optional field
    // is ignored, never a 400 that derails the task the agent is actually on.
    lenientArguments: true,
    name: 'report_feedback',
    description:
      'Report a problem or friction with Runpod or these tools: a wrong result, a confusing error, a docs gap, an API behavior that surprised you. The report is stored for internal review by Runpod to fix issues — nothing is returned to you and no follow-up will reach this session. One concrete observation per call; paste the exact failing request/response into content when relevant. Set severity and tool when you can — they are what lets Runpod sort a blocker from a nit without reading every report. Only for a real observation: never call this to satisfy a requirement to use a tool, and never with placeholder content. Never include API keys or secrets.',
    inputSchema: alpInputSchema(
      'The observation: what happened, what you expected, and the exact error or response text if you have it.',
      {
        severity: {
          type: 'string' as const,
          enum: [...SEVERITY],
          description:
            'How much this cost you: blocked (you could not complete the task at all), degraded (you completed it the slow or awkward way), cosmetic (correct but confusing or badly worded). Report the effect on your task, not how bad the underlying bug looks.',
        },
        tool: TOOL_FIELD,
        workaround: {
          type: 'string' as const,
          description:
            'What you did instead, if anything worked. Leave this out when nothing did — an absent workaround is read as fully blocked.',
        },
      }
    ),
    handler: async (ctx, args) => {
      const { recorded } = await submit(
        ctx,
        opts.ingestUrl,
        'feedback',
        args,
        extra()
      );
      return ok({
        recorded,
        note: recorded
          ? 'Recorded for internal review. No reply will arrive in this session — continue your task.'
          : NOT_RECORDED,
      });
    },
  };

  const saveToJournal: CuratedTool = {
    // FAIL-SOFT applies to the argument gate too: a misnamed optional field
    // is ignored, never a 400 that derails the task the agent is actually on.
    lenientArguments: true,
    name: 'save_to_journal',
    description:
      "Save something you learned about using Runpod that a future session would benefit from (e.g. 'image X needs CUDA 12.8', 'endpoint type cannot be changed after create'). The journal is private to this account: read_journal returns these entries to a future session on the same account and to nobody else. Runpod reviews entries in aggregate to improve the platform. Set trigger when you can — an entry with no stated trigger cannot be surfaced to the session that needs it. Never include API keys or secrets.",
    inputSchema: alpInputSchema(
      'The learning, stated so a future agent can act on it: the situation, what turned out to be true, and how you verified it.',
      {
        trigger: {
          type: 'string' as const,
          description:
            'The situation in which a future agent should recall this — the circumstances that make it relevant, not a restatement of the lesson. This is what makes the entry findable later, so write it as the condition you would want matched.',
        },
        tool: TOOL_FIELD,
      }
    ),
    handler: async (ctx, args) => {
      const { recorded } = await submit(
        ctx,
        opts.ingestUrl,
        'journal',
        args,
        extra()
      );
      return ok({
        recorded,
        note: recorded
          ? "Saved to this account's private journal. A future session on this account can read it back with read_journal. Continue your task."
          : NOT_RECORDED,
      });
    },
  };

  const askQuestion: CuratedTool = {
    // FAIL-SOFT applies to the argument gate too: a misnamed optional field
    // is ignored, never a 400 that derails the task the agent is actually on.
    lenientArguments: true,
    name: 'ask_question',
    description:
      'Record a question about Runpod that you could not answer with the available tools, skills, and docs. NO ANSWER WILL COME BACK — not now and not later in this session; do not wait, poll, or retry. Questions are collected so Runpod learns what its docs and tools fail to cover. Ask when genuinely stuck (it costs one call and improves what future agents get), then consult the runpod://skills/ resources and continue with your best judgment. Only for a real question: never call this to satisfy a requirement to use a tool, and never with placeholder content — if you have no Runpod question, do not call it.',
    inputSchema: alpInputSchema(
      'The question, with enough context that someone reading it later understands what you were blocked on.',
      { tool: TOOL_FIELD }
    ),
    handler: async (ctx, args) => {
      const { recorded } = await submit(
        ctx,
        opts.ingestUrl,
        'question',
        args,
        extra()
      );
      return ok({
        recorded,
        answer: null,
        note: recorded
          ? 'Recorded. No answer is coming — not now, not later in this session. Do not wait, poll, or retry. Check the runpod://skills/ resources for existing guidance and continue with your best judgment.'
          : NOT_RECORDED,
      });
    },
  };

  const readUrl = journalReadUrl(opts.ingestUrl);
  const readJournalTool: CuratedTool = {
    lenientArguments: true,
    name: 'read_journal',
    description:
      "Read back this account's private journal: the lessons earlier sessions on this account saved with save_to_journal, newest first. Call it once near the start of a Runpod task to pick up what was already learned (an image's CUDA floor, a field that turned out to be immutable, a region with no stock). Entries are scoped to the account behind your API key — you cannot read any other account's journal, and there is no argument to ask for one. Only call when you have a Runpod task the entries could inform; never to satisfy a requirement to use a tool.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'integer' as const,
          minimum: 1,
          maximum: MAX_JOURNAL_LIMIT,
          description: `How many of the newest entries to return. Default ${DEFAULT_JOURNAL_LIMIT}, maximum ${MAX_JOURNAL_LIMIT}.`,
        },
      },
    },
    handler: async (ctx, args) => {
      const { available, entries } = await readJournal(
        ctx,
        readUrl,
        clampLimit(args.limit)
      );
      return ok({
        available,
        count: entries.length,
        entries,
        note: !available
          ? 'The journal could not be read right now. Do not retry — continue your task.'
          : entries.length === 0
            ? 'This account has no journal entries yet. Continue your task; save what you learn with save_to_journal.'
            : "These are earlier sessions' own notes, not verified documentation: confirm anything time-sensitive (stock, prices, versions) with a live read before acting on it.",
      });
    },
  };

  return [reportFeedback, saveToJournal, askQuestion, readJournalTool];
}
