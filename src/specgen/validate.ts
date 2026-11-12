// Full-schema argument validation. validateArguments (dispatch.ts) checks only
// missing and unknown top-level keys, so a wrong enum, type or range — and
// anything nested inside `body` — reached the API, where the agent got back an
// upstream 400 or, with a bad key, a 401 that hid the shape problem entirely.
// This checks each call against the complete inputSchema the tool advertises
// (or, for a schemaOnDemand tool, the one describe-tool serves).
//
// It runs in one of three modes, set by MCP_SCHEMA_VALIDATION:
//   off     — not run.
//   shadow  — (default) run and log a `schema_violation` line; the call still
//             goes out unchanged. This exists because the vendored spec can
//             be stricter than the live API, and a violation the API would
//             have accepted must surface in logs before it blocks a call.
//   enforce — run and reject the call with field-level errors before dispatch.
//
// Validation never changes the arguments a handler receives; it only decides
// whether the call proceeds.

import type { ErrorObject, ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

export type SchemaValidationMode = 'off' | 'shadow' | 'enforce';

export function schemaValidationMode(
  value: string | undefined = process.env.MCP_SCHEMA_VALIDATION
): SchemaValidationMode {
  const mode = value?.trim().toLowerCase();
  return mode === 'off' || mode === 'enforce' ? mode : 'shadow';
}

export interface SchemaViolation {
  /** Dotted argument path, e.g. `body.action`; empty for the top level. */
  path: string;
  /** The JSON Schema keyword that failed (enum, type, maximum, required…). */
  keyword: string;
  message: string;
  /** Allowed values, for an enum or const failure. Server-defined, so safe. */
  allowed?: unknown[];
  /** Location in the tool's schema. Server-defined: carries no argument
   *  values or user-chosen keys, so it is what the shadow log records. */
  schemaPath: string;
}

// The spec is JSON Schema 2020-12 (prefixItems, $defs), so the 2020 dialect:
// the default draft-07 Ajv ignores prefixItems. Formats are off: the API
// validates them, and ajv-formats would be another runtime dependency for
// checks that duplicate upstream ones.
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: false,
});

// Compiled lazily, once per schema object: a hosted cold start pays only for
// the tools it is actually asked to call.
const compiled = new WeakMap<object, ValidateFunction>();

function validatorFor(schema: object): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(structuredClone(schema));
    compiled.set(schema, validate);
  }
  return validate;
}

// Strict-schema clients (Codex, opencode) send every property, so an optional
// argument they mean to leave out arrives as null — at any depth, not only the
// top level withoutNullOptionals handles. No schema here accepts null, so a
// null that fails only on `type` is taken as an omission: removed, and the
// call revalidated. A null for a REQUIRED property then fails as `required`,
// which is the correct verdict.
const MAX_NULL_PASSES = 8;

function isNullTypeError(error: ErrorObject, data: unknown): boolean {
  return (
    error.keyword === 'type' &&
    error.instancePath !== '' &&
    valueAt(data, error.instancePath) === null
  );
}

function pointerSegments(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function valueAt(data: unknown, pointer: string): unknown {
  let node: unknown = data;
  for (const key of pointerSegments(pointer)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

// Removes the property at `pointer`; false when there is nothing removable —
// a null array item is a real value, not an omitted property.
function removeAt(data: unknown, pointer: string): boolean {
  const segments = pointerSegments(pointer);
  const last = segments.pop();
  const parent = valueAt(data, segments.length ? `/${segments.join('/')}` : '');
  if (last === undefined || parent === null || typeof parent !== 'object')
    return false;
  if (Array.isArray(parent)) return false;
  delete (parent as Record<string, unknown>)[last];
  return true;
}

// `if` only reports that a `then` branch failed; the branch's own errors say
// which field, so the wrapper is noise to an agent.
const WRAPPER_KEYWORDS = new Set(['if']);

function toViolation(error: ErrorObject): SchemaViolation {
  const base = pointerSegments(error.instancePath);
  let path = base.join('.');
  let message = error.message ?? 'is invalid';
  const params = error.params as Record<string, unknown>;
  if (
    error.keyword === 'required' &&
    typeof params.missingProperty === 'string'
  ) {
    path = [...base, params.missingProperty].join('.');
    message = 'is required';
  } else if (
    error.keyword === 'additionalProperties' &&
    typeof params.additionalProperty === 'string'
  ) {
    path = [...base, params.additionalProperty].join('.');
    message = 'is not an accepted argument here';
  }
  const allowed =
    error.keyword === 'enum'
      ? (params.allowedValues as unknown[])
      : error.keyword === 'const'
        ? [params.allowedValue]
        : undefined;
  return {
    path,
    keyword: error.keyword,
    message,
    ...(allowed ? { allowed } : {}),
    schemaPath: error.schemaPath,
  };
}

/**
 * Validate `args` against a tool's full inputSchema. Returns the violations,
 * empty when the call is valid. `omitted` names top-level arguments the tool
 * treats as absent when empty (dispatch drops empty optional query params), so
 * an empty value there is not reported.
 */
export function schemaViolations(
  schema: object,
  args: Record<string, unknown>,
  omitted: (name: string, value: unknown) => boolean = () => false
): SchemaViolation[] {
  const validate = validatorFor(schema);
  const data: Record<string, unknown> = structuredClone(
    Object.fromEntries(
      Object.entries(args).filter(([name, value]) => !omitted(name, value))
    )
  );
  for (let pass = 0; ; pass++) {
    if (validate(data)) return [];
    const errors = validate.errors ?? [];
    let removed = false;
    if (pass < MAX_NULL_PASSES) {
      for (const error of errors.filter((e) => isNullTypeError(e, data)))
        removed = removeAt(data, error.instancePath) || removed;
    }
    if (!removed) {
      return errors
        .filter((e) => !WRAPPER_KEYWORDS.has(e.keyword))
        .map(toViolation);
    }
  }
}

// Call-shape-only tools get the describe-tool pointer appended by the shared
// recovery hint (server.ts), so it is not repeated here.
export const INVALID_ARGUMENTS_HINT = 'Fix the listed fields and call again.';

export function invalidArgumentsPayload(violations: SchemaViolation[]) {
  return {
    error: 'Invalid arguments',
    code: 'invalid_arguments',
    fields: violations.map(({ path, message, allowed }) => ({
      path,
      problem: message,
      ...(allowed ? { allowed } : {}),
    })),
    hint: INVALID_ARGUMENTS_HINT,
  };
}

// One line per rejected-or-would-reject call. Records only server-defined
// schema locations and keywords: never argument values or user-chosen keys
// (see the SECURITY note in ops.ts).
export function logSchemaViolations(
  tool: string,
  mode: SchemaValidationMode,
  violations: SchemaViolation[]
): void {
  console.error(
    'schema_violation',
    JSON.stringify({
      tool,
      mode,
      violations: violations.map(({ keyword, schemaPath }) => ({
        keyword,
        schemaPath,
      })),
    })
  );
}
