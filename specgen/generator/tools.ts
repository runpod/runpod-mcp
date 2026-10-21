// Pure OpenAPI-to-tool transformation, shared by the CLI and fixture tests.
import type {
  GeneratedTool,
  GeneratedToolParam,
  ToolAnnotations,
} from '#src/specgen/generated/tools.gen';
import { titleFromName } from '#src/specgen/titles';
import { compactDescription, type OperationNameLookup } from './prose.js';

export interface GeneratorConfig {
  exclude?: Record<string, { replacedBy?: string; reason: string }>;
  rename?: Record<string, string>;
  /** operationId -> title overrides; default is derived from the tool name. */
  titles?: Record<string, string>;
  descriptions?: Record<string, string>;
  /** operationId -> description served in the directory profile
   *  (src/specgen/profile.ts) instead of the default one. */
  directoryDescriptions?: Record<string, string>;
  /** Schema address -> description served instead of the spec's. Addresses are
   *  `DefName`, `DefName.prop` (composition is transparent, `[]` for items),
   *  `operationId.param`, or `operationId.body(.prop)`. */
  propertyDescriptions?: Record<string, string>;
  /** operationId -> hints for tools whose HTTP method understates what they do. */
  annotations?: Record<string, Partial<ToolAnnotations>>;
  /** operationIds listed with their call shape only; describe-tool serves the
   *  full schema (src/specgen/on-demand.ts). */
  schemaOnDemand?: string[];
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

const joinAddress = (parent: string, name: string) =>
  parent ? `${parent}.${name}` : name;

function childAddress(key: string, address: string): string {
  if (key === 'items') return `${address}[]`;
  if (key === 'additionalProperties') return joinAddress(address, '*');
  return address;
}

// Walk schema positions only. An enum, default, example or property name may
// contain text that looks like prose or a reference; those are API data. The
// address names a position for overrides: definitions restart it, properties
// extend it, composition keywords and prefixItems pass it through unchanged
// and mark the member as composed, so one address can name the whole and its
// parts.
function mapSchema(
  node: unknown,
  map: (
    schema: Record<string, unknown>,
    address: string,
    composed: boolean
  ) => Record<string, unknown>,
  address = '',
  composed = false
): unknown {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  const schema = Object.fromEntries(
    Object.entries(node).map(([key, value]) => {
      if (schemaMaps.has(key) && value && typeof value === 'object') {
        const definitions = key === '$defs' || key === 'definitions';
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              mapSchema(
                child,
                map,
                definitions ? name : joinAddress(address, name)
              ),
            ])
          ),
        ];
      }
      if (schemaArrays.has(key) && Array.isArray(value))
        return [
          key,
          value.map((child) => mapSchema(child, map, address, true)),
        ];
      if (schemaChildren.has(key))
        return [key, mapSchema(value, map, childAddress(key, address))];
      return [key, value];
    })
  );
  return map(schema, address, composed);
}

function rewriteRef(ref: string): string {
  return ref.startsWith('#/components/schemas/')
    ? ref.replace('#/components/schemas/', '#/$defs/')
    : ref;
}

interface ProseContext {
  compact: (text: string) => string;
  overrides: Record<string, string>;
  usedOverrides: Set<string>;
  // Reached only through allOf: the root description is a note about schema
  // composition, not about any argument.
  compositionDefs: Set<string>;
}

function normalizeSchema(
  node: unknown,
  address: string,
  context: ProseContext
): unknown {
  return mapSchema(
    node,
    (schema, at, composed) => {
      if (typeof schema.title === 'string') schema.title = prose(schema.title);
      // A composition or prefixItems member shares its parent's address; the
      // override describes the whole, so it lands once, on the parent.
      const override = composed ? undefined : context.overrides[at];
      if (override !== undefined) {
        schema.description = override;
        context.usedOverrides.add(at);
      } else if (typeof schema.description === 'string') {
        if (context.compositionDefs.has(at)) delete schema.description;
        else schema.description = context.compact(prose(schema.description));
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
    },
    address
  );
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
// always true. By default only DELETE is marked destructive, and a repeated
// GET, DELETE or PUT lands on the same state, so those are idempotent. The
// method is only a starting point: destructiveHint means "can delete a
// resource, lose data that cannot be read back, or interrupt work in flight"
// (src/specgen/tools/annotations.ts), and a POST or PATCH that does one of
// those, or a write whose repeat is a no-op, is overridden in the generator
// config's annotations.
function annotationsFor(method: string): ToolAnnotations {
  return {
    readOnlyHint: method === 'GET',
    destructiveHint: method === 'DELETE',
    idempotentHint: method === 'GET' || method === 'DELETE' || method === 'PUT',
    openWorldHint: true,
  };
}

const SCHEMA_PREFIX = '#/components/schemas/';

function compositionOnlyDefs(spec: SpecDocument): Set<string> {
  const uses = new Map<string, { allOf: number; other: number }>();
  const note = (ref: unknown, inAllOf: boolean) => {
    if (typeof ref !== 'string' || !ref.startsWith(SCHEMA_PREFIX)) return;
    const name = pointerName(ref, SCHEMA_PREFIX);
    const use = uses.get(name) ?? { allOf: 0, other: 0 };
    if (inAllOf) use.allOf += 1;
    else use.other += 1;
    uses.set(name, use);
  };
  const walk = (node: unknown, inAllOf: boolean) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inAllOf);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') note(value, inAllOf);
      else if (key === 'allOf' && Array.isArray(value))
        for (const child of value) walk(child, true);
      else walk(value, false);
    }
  };
  walk(spec.components ?? {}, false);
  walk(spec.paths, false);
  return new Set(
    [...uses]
      .filter(([, use]) => use.allOf > 0 && use.other === 0)
      .map(([name]) => name)
  );
}

function toolName(operationId: string, config: GeneratorConfig): string {
  return (
    config.rename?.[operationId] ??
    operationId.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
  );
}

function operationNames(
  spec: SpecDocument,
  config: GeneratorConfig
): OperationNameLookup {
  const names = new Map<string, string>();
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op?.operationId) continue;
      const excluded = config.exclude?.[op.operationId];
      const name = excluded
        ? excluded.replacedBy
        : toolName(op.operationId, config);
      if (name) names.set(`${method.toUpperCase()} ${path}`, name);
    }
  }
  return (method, path) => names.get(`${method} ${path}`);
}

function buildTool(
  path: string,
  method: string,
  pathItem: PathItem,
  op: Operation,
  spec: SpecDocument,
  config: GeneratorConfig,
  defs: Record<string, unknown>,
  context: ProseContext
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
    properties[param.name] = normalizeSchema(
      {
        ...(param.schema as Record<string, unknown>),
        ...(param.description ? { description: param.description } : {}),
      },
      `${op.operationId}.${param.name}`,
      context
    );
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
    properties.body = normalizeSchema(
      bodySchema,
      `${op.operationId}.body`,
      context
    );
    if (requestBody?.required) required.push('body');
  }
  // A top-level argument that is a bare $ref carries no type of its own.
  // Directory reviews read each argument's type at the top level and flag the
  // bare ref, so copy the referenced definition's type alongside it.
  for (const property of Object.values(properties)) {
    const schema = property as Record<string, unknown>;
    if (typeof schema.$ref !== 'string' || 'type' in schema) continue;
    const def = defs[schema.$ref.split('/').pop() ?? ''] as
      | Record<string, unknown>
      | undefined;
    if (def && 'type' in def) schema.type = def.type;
  }
  const $defs = reachableDefs({ type: 'object', properties }, defs);
  const name = toolName(op.operationId, config);
  return {
    name,
    title: config.titles?.[op.operationId] ?? titleFromName(name),
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
    ...(config.directoryDescriptions?.[op.operationId]
      ? { directoryDescription: config.directoryDescriptions[op.operationId] }
      : {}),
    method: method.toUpperCase(),
    path,
    params,
    hasBody,
    annotations: {
      ...annotationsFor(method.toUpperCase()),
      ...config.annotations?.[op.operationId],
    },
    ...(config.schemaOnDemand?.includes(op.operationId)
      ? { schemaOnDemand: true as const }
      : {}),
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
  const lookup = operationNames(spec, config);
  const context: ProseContext = {
    compact: (text) => compactDescription(text, lookup),
    overrides: config.propertyDescriptions ?? {},
    usedOverrides: new Set(),
    compositionDefs: compositionOnlyDefs(spec),
  };
  const defs = Object.fromEntries(
    Object.entries(spec.components?.schemas ?? {}).map(([name, schema]) => [
      name,
      normalizeSchema(schema, name, context),
    ])
  );
  const tools: GeneratedTool[] = [];
  const names = new Set<string>();
  const unmatchedExclusions = new Set(Object.keys(config.exclude ?? {}));
  const unmatchedTitles = new Set(Object.keys(config.titles ?? {}));
  const unmatchedDirectory = new Set(
    Object.keys(config.directoryDescriptions ?? {})
  );
  const unmatchedAnnotations = new Set(Object.keys(config.annotations ?? {}));
  const unmatchedOnDemand = new Set(config.schemaOnDemand ?? []);
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      if (Object.hasOwn(config.exclude ?? {}, op.operationId)) {
        unmatchedExclusions.delete(op.operationId);
        continue;
      }
      unmatchedTitles.delete(op.operationId);
      unmatchedDirectory.delete(op.operationId);
      unmatchedAnnotations.delete(op.operationId);
      unmatchedOnDemand.delete(op.operationId);
      const tool = buildTool(
        path,
        method,
        pathItem,
        op,
        spec,
        config,
        defs,
        context
      );
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
  if (unmatchedDirectory.size)
    throw new Error(
      `Directory-described operations missing from spec: ${[...unmatchedDirectory].sort().join(', ')}`
    );
  if (unmatchedTitles.size)
    throw new Error(
      `Titled operations missing from spec: ${[...unmatchedTitles].sort().join(', ')}`
    );
  if (unmatchedAnnotations.size)
    throw new Error(
      `Annotated operations missing from spec: ${[...unmatchedAnnotations].sort().join(', ')}`
    );
  if (unmatchedOnDemand.size)
    throw new Error(
      `schemaOnDemand operations missing from spec: ${[...unmatchedOnDemand].sort().join(', ')}`
    );
  const unmatchedOverrides = Object.keys(context.overrides).filter(
    (address) => !context.usedOverrides.has(address)
  );
  if (unmatchedOverrides.length)
    throw new Error(
      `Property description overrides missing from spec: ${unmatchedOverrides.sort().join(', ')}`
    );
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}
