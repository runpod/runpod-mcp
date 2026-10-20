// Every tool is listed by name, title, description and annotations, but a tool
// flagged `schemaOnDemand` lists only its call shape: the top-level arguments
// with their types and a lead sentence each, nested objects collapsed. The
// full schema is served by describe-tool and still gates every call, so what
// a tool accepts does not change — only what every handshake carries.

import type { ToolAnnotations } from './generated/tools.gen.js';
import { leadSentence } from './prose.js';

export const DESCRIBE_TOOL_NAME = 'describe-tool';

const ON_DEMAND_POINTER = ` Call ${DESCRIBE_TOOL_NAME} for the full argument schema before the first use.`;

type Schema = Record<string, unknown>;

export interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: Partial<ToolAnnotations>;
}

export interface ListableTool extends ListedTool {
  annotations: ToolAnnotations;
  schemaOnDemand?: boolean;
}

// Every tools/list carries the annotations of every tool, so idempotentHint is
// left out when false, its MCP spec default; the client reads the same value
// either way. The other three are always sent: hosts gate on readOnlyHint and
// destructiveHint (which defaults to true), and some directory reviews look
// for openWorldHint itself.
export function listedAnnotations(
  annotations: ToolAnnotations
): Partial<ToolAnnotations> {
  const { idempotentHint, ...listed } = annotations;
  return idempotentHint ? annotations : listed;
}

export function listTool(tool: ListableTool): ListedTool {
  const { name, title, description, inputSchema } = tool;
  const annotations = listedAnnotations(tool.annotations);
  if (!tool.schemaOnDemand)
    return { name, title, description, inputSchema, annotations };
  return {
    name,
    title,
    description: description + ON_DEMAND_POINTER,
    inputSchema: callShape(inputSchema),
    annotations,
  };
}

export function callShape(schema: Schema): Schema {
  const defs = (schema.$defs ?? {}) as Record<string, Schema>;
  const resolve = (node: Schema): Schema => {
    if (typeof node.$ref !== 'string') return node;
    const name = node.$ref.split('/').pop() ?? '';
    return defs[name] ?? {};
  };
  const properties = Object.fromEntries(
    Object.entries((schema.properties ?? {}) as Record<string, Schema>).map(
      ([key, value]) => [key, shallowProperty(resolve(value), resolve)]
    )
  );
  return {
    type: 'object',
    properties,
    ...(schema.required ? { required: schema.required } : {}),
  };
}

type Resolve = (node: Schema) => Schema;

function shallowProperty(node: Schema, resolve: Resolve): Schema {
  const out: Schema = {};
  const type = schemaType(node, resolve);
  if (type !== undefined) out.type = type;
  if (type === 'array') {
    const items = resolve((node.items ?? {}) as Schema);
    const itemType = schemaType(items, resolve);
    if (itemType !== undefined) out.items = { type: itemType };
  }
  if (Array.isArray(node.enum)) out.enum = node.enum;
  if (typeof node.description === 'string')
    out.description = leadSentence(node.description);
  return out;
}

function schemaType(node: Schema, resolve: Resolve): unknown {
  if (node.type !== undefined) return node.type;
  if (node.properties || node.allOf) return 'object';
  const branches = (node.anyOf ?? node.oneOf) as Schema[] | undefined;
  const allObjects =
    branches?.every(
      (branch) => schemaType(resolve(branch), resolve) === 'object'
    ) ?? false;
  return allObjects ? 'object' : undefined;
}
