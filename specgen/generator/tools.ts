// Pure OpenAPI-to-tool transformation, shared by the CLI and fixture tests.
import type {
  GeneratedTool,
  GeneratedToolParam,
  ToolAnnotations,
} from '../../src/specgen/generated/tools.gen.js';

export interface GeneratorConfig {
  exclude?: Record<string, { replacedBy?: string; reason: string }>;
  rename?: Record<string, string>;
  descriptions?: Record<string, string>;
}

interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  explode?: boolean;
  description?: string;
  schema?: unknown;
}
interface RequestBody {
  $ref?: string;
  required?: boolean;
  content?: Record<string, { schema?: unknown }>;
}
interface Operation {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
}
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
type PathItem = Partial<Record<(typeof HTTP_METHODS)[number], Operation>> & {
  parameters?: Parameter[];
};
export interface SpecDocument {
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, unknown>;
    parameters?: Record<string, Parameter>;
    requestBodies?: Record<string, RequestBody>;
  };
}

const prose = (value: string) => value.replaceAll('RunPod', 'Runpod');
const schemaMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaChildren = new Set([
  'items',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
]);

// Walk schema positions only. An enum, default, example or property name may
// contain text that looks like prose or a reference; those are API data.
function mapSchema(
  node: unknown,
  map: (schema: Record<string, unknown>) => Record<string, unknown>
): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const schema = Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (schemaMaps.has(key) && value && typeof value === 'object') {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              mapSchema(child, map),
            ])
          ),
        ];
      }
      if (schemaArrays.has(key) && Array.isArray(value))
        return [key, value.map((child) => mapSchema(child, map))];
      if (schemaChildren.has(key)) return [key, mapSchema(value, map)];
      return [key, value];
    })
  );
  return map(schema);
}

function rewriteRef(ref: string): string {
  return ref.startsWith('#/components/schemas/')
    ? ref.replace('#/components/schemas/', '#/$defs/')
    : ref;
}

function normalizeSchema(node: unknown): unknown {
  return mapSchema(node, (schema) => {
    for (const key of ['description', 'title']) {
      if (typeof schema[key] === 'string') schema[key] = prose(schema[key]);
    }
    for (const key of ['$ref', '$dynamicRef']) {
      if (typeof schema[key] === 'string')
        schema[key] = rewriteRef(schema[key]);
    }
    const discriminator = schema.discriminator as
      | { mapping?: Record<string, string> }
      | undefined;
    if (discriminator?.mapping) {
      schema.discriminator = {
        ...discriminator,
        mapping: Object.fromEntries(
          Object.entries(discriminator.mapping).map(([key, ref]) => [
            key,
            rewriteRef(ref),
          ])
        ),
      };
    }
    return schema;
  });
}

function pointerName(ref: string, prefix: string): string {
  return decodeURIComponent(ref.slice(prefix.length).split('/')[0])
    .replaceAll('~1', '/')
    .replaceAll('~0', '~');
}

function referencedDefs(schema: unknown): string[] {
  const names: string[] = [];
  mapSchema(schema, (node) => {
    const discriminator = node.discriminator as
      | { mapping?: Record<string, string> }
      | undefined;
    const refs = [
      node.$ref,
      node.$dynamicRef,
      ...Object.values(discriminator?.mapping ?? {}),
    ];
    for (const ref of refs) {
      if (typeof ref === 'string' && ref.startsWith('#/$defs/'))
        names.push(pointerName(ref, '#/$defs/'));
    }
    return node;
  });
  return names;
}

function reachableDefs(
  schema: unknown,
  defs: Record<string, unknown>
): Record<string, unknown> {
  const seen = new Set<string>();
  const queue = referencedDefs(schema);
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    if (!Object.hasOwn(defs, name))
      throw new Error(`Missing schema definition: ${name}`);
    seen.add(name);
    queue.push(...referencedDefs(defs[name]));
  }
  return Object.fromEntries([...seen].sort().map((name) => [name, defs[name]]));
}

function resolveComponent<T extends { $ref?: string }>(
  value: T,
  kind: 'parameters' | 'requestBodies',
  components: Record<string, T> = {}
): T {
  const seen = new Set<string>();
  while (value.$ref) {
    const ref = value.$ref;
    const prefix = `#/components/${kind}/`;
    if (!ref.startsWith(prefix) || seen.has(ref))
      throw new Error(`Unsupported or cyclic ${kind} reference: ${ref}`);
    seen.add(ref);
    const resolved = components[pointerName(ref, prefix)];
    if (!resolved) throw new Error(`Missing ${kind} reference: ${ref}`);
    value = resolved;
  }
  return value;
}

function operationParameters(
  pathItem: PathItem,
  op: Operation,
  spec: SpecDocument
): Parameter[] {
  const parameters = new Map<string, Parameter>();
  for (const raw of [
    ...(pathItem.parameters ?? []),
    ...(op.parameters ?? []),
  ]) {
    const param = resolveComponent(
      raw,
      'parameters',
      spec.components?.parameters
    );
    // OpenAPI operation parameters override path-level parameters by (in, name).
    parameters.set(`${param.in}:${param.name}`, param);
  }
  return [...parameters.values()];
}

// MCP tool annotations, derived from the HTTP method the tool wraps so they
// cannot drift from the surface: hosts read these to decide what a human has
// to approve. Every operation reaches the Runpod API, so openWorldHint is
// always true. Writes that create or update (POST/PATCH) are additive, so
// only DELETE is marked destructive; a repeated DELETE or PUT lands on the
// same state, so those are idempotent — as does any GET.
function annotationsFor(method: string): ToolAnnotations {
  return {
    readOnlyHint: method === 'GET',
    destructiveHint: method === 'DELETE',
    idempotentHint: method === 'GET' || method === 'DELETE' || method === 'PUT',
    openWorldHint: true,
  };
}

function buildTool(
  path: string,
  method: string,
  pathItem: PathItem,
  op: Operation,
  spec: SpecDocument,
  config: GeneratorConfig,
  defs: Record<string, unknown>
): GeneratedTool {
  if (!op.operationId)
    throw new Error(`Missing operationId: ${method} ${path}`);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const params: GeneratedToolParam[] = [];
  for (const param of operationParameters(pathItem, op, spec)) {
    if (param.in !== 'path' && param.in !== 'query')
      throw new Error(
        `Unsupported parameter location ${param.in}: ${op.operationId}`
      );
    if (!param.name)
      throw new Error(`Missing parameter name: ${op.operationId}`);
    if (Object.hasOwn(properties, param.name))
      throw new Error(`Ambiguous parameter ${param.name}: ${op.operationId}`);
    properties[param.name] = normalizeSchema({
      ...(param.schema as Record<string, unknown>),
      ...(param.description ? { description: param.description } : {}),
    });
    if (param.required || param.in === 'path') required.push(param.name);
    params.push({
      name: param.name,
      location: param.in,
      ...(param.explode === false ? { explode: false as const } : {}),
    });
  }
  const requestBody =
    op.requestBody &&
    resolveComponent(
      op.requestBody,
      'requestBodies',
      spec.components?.requestBodies
    );
  const bodySchema = requestBody?.content?.['application/json']?.schema;
  const hasBody = bodySchema !== undefined;
  if (hasBody) {
    if (Object.hasOwn(properties, 'body'))
      throw new Error(
        `Parameter conflicts with request body: ${op.operationId}`
      );
    properties.body = normalizeSchema(bodySchema);
    if (requestBody?.required) required.push('body');
  }
  const $defs = reachableDefs({ type: 'object', properties }, defs);
  return {
    name:
      config.rename?.[op.operationId] ??
      op.operationId.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(),
    operationId: op.operationId,
    description:
      config.descriptions?.[op.operationId] ??
      prose(
        [op.summary, op.description]
          .filter(Boolean)
          .join('. ')
          .replaceAll(/\s+/g, ' ')
          .trim()
      ),
    method: method.toUpperCase(),
    path,
    params,
    hasBody,
    annotations: annotationsFor(method.toUpperCase()),
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
      ...(Object.keys($defs).length ? { $defs } : {}),
    },
  };
}

export function generateTools(
  spec: SpecDocument,
  config: GeneratorConfig = {}
): GeneratedTool[] {
  const defs = Object.fromEntries(
    Object.entries(spec.components?.schemas ?? {}).map(([name, schema]) => [
      name,
      normalizeSchema(schema),
    ])
  );
  const tools: GeneratedTool[] = [];
  const names = new Set<string>();
  const unmatchedExclusions = new Set(Object.keys(config.exclude ?? {}));
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (Object.hasOwn(config.exclude ?? {}, op.operationId)) {
        unmatchedExclusions.delete(op.operationId);
        continue;
      }
      const tool = buildTool(path, method, pathItem, op, spec, config, defs);
      if (names.has(tool.name))
        throw new Error(`Duplicate tool name: ${tool.name}`);
      names.add(tool.name);
      tools.push(tool);
    }
  }
  if (unmatchedExclusions.size)
    throw new Error(
      `Excluded operations missing from spec: ${[...unmatchedExclusions].sort().join(', ')}`
    );
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}
