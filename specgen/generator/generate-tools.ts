// Generates src/specgen/generated/tools.gen.ts from specgen/spec/openapi.yaml
// and specgen/generator-config.yaml: one MCP tool per operation — name, description, and
// parameter JSON Schema straight from the spec, dispatch metadata for the
// runtime. Run with: pnpm generate:tools

import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';

interface Exclusion {
  replacedBy?: string;
  reason: string;
}

interface GeneratorConfig {
  exclude?: Record<string, Exclusion>;
  rename?: Record<string, string>;
  descriptions?: Record<string, string>;
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

// House style is "Runpod"; the upstream spec writes "RunPod" in a handful of
// prose descriptions. The vendored spec is a verbatim copy of the live
// production document (scripts/pull-spec.ts overwrites it wholesale, so a
// local edit there is silently lost on the next re-vendor) — normalize on the
// way INTO generation instead, which survives every spec:pull and keeps the
// vendored file byte-identical to upstream. Only prose is touched: operation
// ids, paths, and property names are never rewritten. Remove this once the
// spelling is fixed upstream in rphttp2.
function houseStyle<T>(node: T): T {
  if (typeof node === 'string') return node.replaceAll('RunPod', 'Runpod') as T;
  if (Array.isArray(node)) return node.map(houseStyle) as T;
  if (node && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [
        key,
        key === 'description' || key === 'summary'
          ? houseStyle(value)
          : value && typeof value === 'object'
            ? houseStyle(value)
            : value,
      ])
    ) as T;
  }
  return node;
}

const spec = houseStyle(
  parse(readFileSync('specgen/spec/openapi.yaml', 'utf8'))
);
const config: GeneratorConfig =
  parse(readFileSync('specgen/generator-config.yaml', 'utf8')) ?? {};
const excluded = new Set(Object.keys(config.exclude ?? {}));

// Internal component refs are rewritten to $defs so each tool's inputSchema is
// a self-contained JSON Schema document.
function inlineRefs<T>(node: T): T {
  return JSON.parse(
    JSON.stringify(node).replaceAll('"#/components/schemas/', '"#/$defs/')
  );
}

const defs: Record<string, unknown> = inlineRefs(
  spec.components?.schemas ?? {}
);

// Collect the $defs a schema fragment actually references, transitively, so a
// tool's inputSchema carries only the definitions its own parameters/body
// reach. Attaching the whole OpenAPI component pool to every tool instead
// makes each schema tens of kilobytes — far too large for an agent prompt.
const DEF_REF = /#\/\$defs\/([^"/]+)/g;

function reachableDefs(fragment: unknown): Record<string, unknown> {
  const seen = new Set<string>();
  const queue = [...JSON.stringify(fragment ?? {}).matchAll(DEF_REF)].map(
    (m) => m[1]
  );
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name) || !(name in defs)) continue;
    seen.add(name);
    for (const m of JSON.stringify(defs[name]).matchAll(DEF_REF)) {
      if (!seen.has(m[1])) queue.push(m[1]);
    }
  }
  const pruned: Record<string, unknown> = {};
  for (const name of [...seen].sort()) pruned[name] = defs[name];
  return pruned;
}

function kebabCase(operationId: string): string {
  return operationId.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

interface ToolParam {
  name: string;
  location: 'path' | 'query';
}

// The slice of an OpenAPI operation this generator reads. Parameters and
// schemas stay unknown-shaped — they are copied into the output, not walked.
interface SpecOperation {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: Array<Record<string, unknown>>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: unknown }>;
  };
}

type SpecPathItem = Partial<
  Record<(typeof HTTP_METHODS)[number], SpecOperation>
> & {
  parameters?: Array<Record<string, unknown>>;
};

const tools: Array<{ name: string }> = [];

for (const [path, pathItem] of Object.entries<SpecPathItem>(spec.paths)) {
  for (const method of HTTP_METHODS) {
    const op = pathItem[method];
    if (!op) continue;
    const operationId: string = op.operationId;
    if (excluded.has(operationId)) continue;

    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const params: ToolParam[] = [];

    const rawParams = [
      ...(pathItem.parameters ?? []),
      ...(op.parameters ?? []),
    ];
    for (const raw of rawParams) {
      const param = raw.$ref
        ? spec.components.parameters[
            raw.$ref.replace('#/components/parameters/', '')
          ]
        : raw;
      if (param.in !== 'path' && param.in !== 'query') continue;
      properties[param.name] = inlineRefs({
        ...param.schema,
        ...(param.description ? { description: param.description } : {}),
      });
      if (param.required) required.push(param.name);
      params.push({ name: param.name, location: param.in });
    }

    const bodySchema = op.requestBody?.content?.['application/json']?.schema;
    if (bodySchema) {
      properties.body = inlineRefs(bodySchema);
      if (op.requestBody.required) required.push('body');
    }

    const description =
      config.descriptions?.[operationId] ??
      [op.summary, op.description]
        .filter(Boolean)
        .join('. ')
        .replaceAll(/\s+/g, ' ')
        .trim();

    tools.push({
      name: config.rename?.[operationId] ?? kebabCase(operationId),
      operationId,
      description,
      method: method.toUpperCase(),
      path,
      params,
      hasBody: Boolean(bodySchema),
      inputSchema: {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
        ...(() => {
          const $defs = reachableDefs(properties);
          return Object.keys($defs).length ? { $defs } : {};
        })(),
      },
    });
  }
}

tools.sort((a, b) => a.name.localeCompare(b.name));

const header = `// Code generated from specgen/spec/openapi.yaml by specgen/generator/generate-tools.ts; DO NOT EDIT.

export interface GeneratedToolParam {
  name: string;
  location: "path" | "query";
}

export interface GeneratedTool {
  name: string;
  operationId: string;
  description: string;
  method: string;
  path: string;
  params: GeneratedToolParam[];
  hasBody: boolean;
  inputSchema: Record<string, unknown>;
}

export const generatedTools: GeneratedTool[] = `;

writeFileSync(
  'src/specgen/generated/tools.gen.ts',
  header + JSON.stringify(tools, null, 2) + ';\n'
);
console.log(
  `generated ${tools.length} tools (${excluded.size} excluded by config)`
);
