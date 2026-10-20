// Serves any tool's full definition. Tools flagged schemaOnDemand list only
// their call shape (src/specgen/on-demand.ts); the rest is read from here.

import { DESCRIBE_TOOL_NAME, type ListableTool } from '../on-demand.js';
import type { CuratedTool } from '../types.js';
import { ok } from './util.js';

export function createDescribeTool(served: () => ListableTool[]): CuratedTool {
  return {
    name: DESCRIBE_TOOL_NAME,
    title: 'Describe tool',
    description:
      "Return one tool's full definition: its description, complete argument schema (every field, nested objects, constraints) and annotations. Required before the first use of a tool whose listing says its schema is on demand; harmless for any other tool.",
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            "A tool name exactly as this server's tool list spells it.",
        },
      },
      required: ['name'],
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (_ctx, args) => {
      const name = String(args.name ?? '');
      const tools = served();
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) {
        return {
          ok: false,
          status: 404,
          payload: {
            error: `No tool named ${name}.`,
            suggestions: similarNames(
              name,
              tools.map((candidate) => candidate.name)
            ),
            hint: 'Tool names are exactly as this server lists them; the suggestions share a word with the name you sent.',
          },
        };
      }
      const { description, inputSchema, annotations } = tool;
      return ok({ name: tool.name, description, inputSchema, annotations });
    },
  };
}

export function similarNames(query: string, names: string[]): string[] {
  const wanted = new Set(words(query));
  return names
    .map((name) => {
      const own = new Set(words(name));
      const shared = [...own].filter((word) => wanted.has(word)).length;
      return { name, score: shared / new Set([...own, ...wanted]).size };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((entry) => entry.name);
}

function words(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.replace(/s$/, ''));
}
