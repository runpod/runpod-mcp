import type { ToolContext } from './context.js';
import type { ToolResult } from './dispatch.js';
import type { ToolAnnotations } from './generated/tools.gen.js';

export type { ToolAnnotations };

export interface CuratedTool {
  name: string;
  /** Human-readable name hosts show in place of `name`, required so a new
   *  curated tool cannot ship without one (directory reviews check every tool).
   *  Sentence case, proper nouns kept (src/specgen/titles.ts). */
  title: string;
  description: string;
  /** Served instead of `description` in the directory profile
   *  (src/specgen/profile.ts): what the tool does, with no instructions to
   *  the model and no other tool named. Omit when `description` already is. */
  directoryDescription?: string;
  inputSchema: Record<string, unknown>;
  /** MCP behavioral hints, required so a new curated tool cannot ship without
   *  them (the generated tools derive theirs from the HTTP method). */
  annotations: ToolAnnotations;
  handler: (
    ctx: ToolContext,
    args: Record<string, unknown>
  ) => Promise<ToolResult>;
  /** tools/list carries only the call shape (src/specgen/on-demand.ts);
   *  describe-tool serves the full schema, which still gates every call. */
  schemaOnDemand?: boolean;
  /** Skip the argument-shape gate. Only for tools whose contract is to never
   *  return an error result (the ALP write tools): an unknown key there is
   *  ignored by the handler rather than rejected, by design. */
  lenientArguments?: boolean;
  /** Argument names whose values go into the anonymous usage event
   *  (src/specgen/analytics.ts). Everything else is dropped. List only
   *  arguments that never carry secrets or resource ids. The one accepted
   *  exception to "no user content" is the free-text `query` of list-guides
   *  and search-concepts: agent-written search words, kept for search
   *  analytics and bounded to 200 characters. */
  recordedArguments?: readonly string[];
  /** Resolves the kind of guide a call reads (skill, reference or
   *  golden-path), recorded as guide_kind. Undefined when nothing matched. */
  recordedGuideKind?: (args: Record<string, unknown>) => string | undefined;
  /** The handler may hold the response open longer than a client's request
   *  timeout (long-poll or streamed reads). The hosted transport answers such
   *  tools over SSE, which clients read under their longer stream timeout;
   *  every other tool answers as JSON so the CDN can compress it. */
  holdsResponse?: boolean;
}
