// Every tool is listed by name, title, description and annotations, but a tool
// flagged `schemaOnDemand` lists only its call shape: the top-level arguments
// with their types and a lead sentence each, nested objects collapsed. The
// full schema is served by describe-tool and still gates every call, so what
// a tool accepts does not change — only what every handshake carries.

import type { ToolAnnotations } from './generated/tools.gen.js';
import { directoryOmittedInputs, type ServerProfile } from './profile.js';
import { leadSentence } from './prose.js';

export const DESCRIBE_TOOL_NAME = 'describe-tool';

const ON_DEMAND_POINTER = ` Call ${DESCRIBE_TOOL_NAME} for the full argument schema before the first use.`;

type Schema = Record<string, unknown>;

export interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: Partial<ToolAnnotations> & { title?: string };
}

export interface ListableTool extends ListedTool {
  annotations: ToolAnnotations;
  schemaOnDemand?: boolean;
  /** Served instead of `description` in the directory profile: what the tool
   *  does, with no instructions to the model and no other tool named. */
  directoryDescription?: string;
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

// The title is sent twice: top level per the current MCP spec, and as
// annotations.title, where earlier spec revisions put it and where directory
// reviews still look for it.
//
// The directory profile lists every tool with its full schema (there is no
// describe-tool to point at), less any omitted inputs, and its
// directoryDescription where it has one.
export function listTool(
  tool: ListableTool,
  profile: ServerProfile = 'default'
): ListedTool {
  const { name, title, inputSchema } = tool;
  const annotations = { title, ...listedAnnotations(tool.annotations) };
  if (profile === 'directory')
    return {
      name,
      title,
      description: withApiReference(
        tool.directoryDescription ?? tool.description,
        inputSchema
      ),
      inputSchema: withoutCredentialExamples(
        withoutInputs(inputSchema, directoryOmittedInputs(name))
      ),
      annotations,
    };
  const { description } = tool;
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

// Directory reviews ask a tool that takes a caller-built request body to name
// the API it calls, so the directory profile appends the REST API reference to
// every tool with a body argument.
export const DIRECTORY_API_REFERENCE =
  'Calls the Runpod REST API v2: https://docs.runpod.io/api-reference-v2/overview';

function withApiReference(description: string, schema: Schema): string {
  const properties = (schema.properties ?? {}) as Schema;
  if (!('body' in properties)) return description;
  const trimmed = description.replace(/\s*$/, '');
  const sentence = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `${sentence} ${DIRECTORY_API_REFERENCE}`;
}

// OpenAI's plugin policy restricts collecting credentials, and an example such
// as {"JUPYTER_PASSWORD": "hunter2"} reads as asking for one. The directory
// profile drops any example that names or holds a credential.
const CREDENTIAL =
  /pass(word|wd|phrase)?|secret|token(?!s)|api_?key|private_?key|credential/i;

function withoutCredentialExamples(schema: Schema): Schema {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== 'object') return node;
    const out: Schema = {};
    for (const [key, value] of Object.entries(node as Schema)) {
      if (key === 'examples' && CREDENTIAL.test(JSON.stringify(value)))
        continue;
      out[key] = strip(value);
    }
    return out;
  };
  return strip(schema) as Schema;
}

function withoutInputs(schema: Schema, omit: readonly string[]): Schema {
  if (!omit.length) return schema;
  const properties = { ...((schema.properties ?? {}) as Schema) };
  for (const key of omit) delete properties[key];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key) => !omit.includes(key as string))
    : schema.required;
  return { ...schema, properties, ...(required ? { required } : {}) };
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
