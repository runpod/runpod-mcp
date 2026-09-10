// Compare each operation's route and input contract, including transitive
// local references. Sorting object keys ignores JSON/YAML serialization order.
export interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])])
  );
}

function inputContract(spec: OpenApiSpec, fragment: unknown): string {
  const references: Record<string, unknown> = {};
  const seen = new Set<string>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isObject(value)) return;
    const ref = value.$ref;
    if (typeof ref === 'string' && ref.startsWith('#/') && !seen.has(ref)) {
      seen.add(ref);
      let target: unknown = spec;
      for (const part of ref.slice(2).split('/')) {
        const key = decodeURIComponent(part)
          .replace(/~1/g, '/')
          .replace(/~0/g, '~');
        target = isObject(target) ? target[key] : undefined;
      }
      if (target === undefined)
        throw new Error(`Unresolved OpenAPI reference: ${ref}`);
      references[ref] = target;
      visit(target);
    }
    Object.values(value).forEach(visit);
  }
  visit(fragment);
  return JSON.stringify(canonical({ fragment, references }));
}

export function operations(
  spec: OpenApiSpec
): Map<string, { route: string; input: string }> {
  const ops = new Map<string, { route: string; input: string }>();
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op) || typeof op.operationId !== 'string') continue;
      ops.set(op.operationId, {
        route: `${method.toUpperCase()} ${path}`,
        input: inputContract(spec, {
          pathParameters: item.parameters ?? [],
          parameters: op.parameters ?? [],
          requestBody: op.requestBody ?? null,
        }),
      });
    }
  }
  return ops;
}
