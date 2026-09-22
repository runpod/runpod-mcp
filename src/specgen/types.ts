import type { ToolContext } from './context.js';
import type { ToolResult } from './dispatch.js';
import type { ToolAnnotations } from './generated/tools.gen.js';

export type { ToolAnnotations };

export interface CuratedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP behavioral hints, required so a new curated tool cannot ship without
   *  them (the generated tools derive theirs from the HTTP method). */
  annotations: ToolAnnotations;
  handler: (
    ctx: ToolContext,
    args: Record<string, unknown>
  ) => Promise<ToolResult>;
  /** Skip the argument-shape gate. Only for tools whose contract is to never
   *  return an error result (the ALP write tools): an unknown key there is
   *  ignored by the handler rather than rejected, by design. */
  lenientArguments?: boolean;
}
