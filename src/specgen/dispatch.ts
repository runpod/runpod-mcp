// Executes a generated tool call by mapping its arguments onto the SDK client:
// path params substitute into the URL template, query params pass through, and
// the optional "body" argument becomes the request body.

import type { RunpodClient } from '@runpod/typescript-api-sdk';
import type { GeneratedTool } from './generated/tools.gen.js';
import { restError } from './clients/rest-result.js';

// A client caches tools/list when it connects. If the served surface changes
// under a live session — a release, or a deployment alias moving — the client
// keeps validating calls against the OLD schema and silently strips arguments
// the new schema requires. The agent cannot see this: from inside the session
// its schema looks authoritative, so it retries variations of a shape the
// server will never accept. A production report burned a session that way,
// sending flat v1 arguments (gpuTypeIds, imageName) at a body-shaped
// create-pod and then re-sending them nested under a `body` key its own client
// dropped, leaving `received: []`. Reconnecting is the only fix, so name it on
// exactly the two errors a stale schema produces.
const STALE_SCHEMA_HINT =
  'If this disagrees with the schema you hold, your tool list may be cached from an earlier version of this server. Reconnect the Runpod MCP server (in Claude Code, /mcp) to refresh tools/list, then call again — do not retry variations of the same argument shape.';

export interface ToolResult {
  ok: boolean;
  status: number;
  payload: unknown;
  /** Internal delivery evidence for recovery hints; never sent to MCP clients. */
  requestDelivery?: 'not_sent' | 'uncertain';
}

// Argument-shape gate, shared by every tool on the server. Two checks, both
// read from the tool's own JSON Schema so no tool needs per-tool code:
//
// Missing required argument. Without this an unresolved path placeholder
// reaches the API and comes back as a resource 404 ("gpu type not found"),
// sending the agent off to re-verify an id that was never sent.
//
// Unknown argument. Handlers only read declared keys, so an argument with a
// plausible-but-wrong name used to vanish in silence and the call still went
// out — `includeAvailability` (the v1 spelling) on list-gpu-types returned a
// 200 with no availability fields at all, which reads as "priced and in stock"
// if you trust the request you thought you made. The curated tools had the
// same hole until the 2026-09-09 release smoke: stream-pod-logs called with
// `id` instead of `podId` fetched /pods/undefined/logs and answered 404
// "pod not found" with a hint to re-verify the id. A wrong answer is worse
// than an error, so name the key and list what the tool accepts.
export function validateArguments(
  inputSchema: { required?: unknown; properties?: unknown },
  args: Record<string, unknown>
): ToolResult | null {
  const required = (inputSchema.required ?? []) as string[];
  const missing = required.filter(
    (name) => args[name] === undefined || args[name] === null
  );
  if (missing.length) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
        expected: required,
        received: Object.keys(args),
        // A missing path/query param is an ordinary omission. A missing `body`
        // is the shape a stale schema produces, so only that one earns the hint.
        ...(missing.includes('body') ? { hint: STALE_SCHEMA_HINT } : {}),
      },
    };
  }
  const allowed = new Set(
    Object.keys((inputSchema.properties ?? {}) as Record<string, unknown>)
  );
  const unknown = Object.keys(args).filter((name) => !allowed.has(name));
  if (unknown.length) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: `Unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
        accepted: [...allowed],
        hint: STALE_SCHEMA_HINT,
      },
    };
  }
  return null;
}

// Strict-schema clients (Codex, opencode) send every property, so an optional
// argument they mean to leave out arrives as null. Curated handlers read their
// arguments by hand and took that null as a value: get-job-status and
// runsync-endpoint rejected `wait: null`, set-endpoint-gpus rejected every
// null GPU field, and run-endpoint forwarded `webhook: null`, `policy: null`
// and `s3Config: null` into the job body. No curated schema accepts null, so a
// null optional argument is dropped before the gate and the handler see it. A
// null REQUIRED argument is kept, so validateArguments still reports it.
export function withoutNullOptionals(
  inputSchema: { required?: unknown },
  args: Record<string, unknown>
): Record<string, unknown> {
  const required = new Set((inputSchema.required ?? []) as string[]);
  return Object.fromEntries(
    Object.entries(args).filter(
      ([name, value]) => value !== null || required.has(name)
    )
  );
}

export async function dispatchGeneratedTool(
  client: RunpodClient,
  tool: GeneratedTool,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const rejected = validateArguments(tool.inputSchema, args);
  if (rejected) return rejected;

  const required = new Set((tool.inputSchema.required ?? []) as string[]);
  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  for (const param of tool.params) {
    if (args[param.name] === undefined) continue;
    // Clients that run OpenAI-style strict tool schemas must send every
    // property, so an optional filter they mean to leave out arrives as null,
    // "" or []. Upstream counts any present value as supplied: cudaVersions: []
    // next to minCudaVersion is a 400 "mutually exclusive", lastN: null next to
    // startTime is "lastN cannot be combined", and cursor: "" is a 422 invalid
    // cursor on the first page. None of those can be meant as a value, so an
    // empty optional query param is treated as omitted.
    if (
      param.location === 'query' &&
      !required.has(param.name) &&
      isEmptyValue(args[param.name])
    )
      continue;
    if (param.location === 'path') {
      pathParams[param.name] = args[param.name];
      continue;
    }
    const value = args[param.name];
    // `explode: false` in the spec means form style with ONE comma-joined
    // value. openapi-fetch's default serializer repeats the key per array
    // item instead, and upstream rejects that with "parameter 'x' is not
    // exploded, but is specified multiple times" — so a multi-value filter
    // fails while a single value passes, which is exactly the shape of bug
    // that survives casual testing.
    query[param.name] =
      param.explode === false && Array.isArray(value) ? value.join(',') : value;
  }

  // Some MCP clients serialize a nested object argument as a JSON string
  // rather than an object. Forwarding that verbatim makes upstream reject the
  // whole request with "$: got string, want object" — which never mentions
  // that the body was stringified, so the agent re-reads the schema it already
  // followed and retries the same shape. Accept the string and parse it; a
  // body that is not valid JSON is the client's error, so name it plainly.
  let requestBody = args.body;
  if (tool.hasBody && typeof requestBody === 'string') {
    try {
      requestBody = JSON.parse(requestBody);
    } catch {
      return {
        ok: false,
        status: 400,
        payload: {
          error:
            'The body argument arrived as a string that is not valid JSON. Send body as an object.',
        },
      };
    }
  }

  // Some clients stringify every scalar inside a nested body (disk: "20",
  // workers.max: "1"), and upstream rejects each one with "$.disk: got string,
  // want integer". The body schema says what each field is, so a string that
  // is exactly a number or boolean where the schema wants one is converted
  // back. Anything else is forwarded untouched for upstream to judge.
  if (tool.hasBody && requestBody !== undefined) {
    const properties = (tool.inputSchema.properties ?? {}) as Record<
      string,
      unknown
    >;
    const defs = ((tool.inputSchema as { $defs?: unknown }).$defs ??
      {}) as Record<string, unknown>;
    requestBody = coerceScalars(requestBody, properties.body, defs);
  }

  // openapi-fetch is typed per literal path; generated dispatch is generic by
  // construction, so the client is narrowed to the structural shape of a verb
  // call rather than asserted to any.
  type VerbCall = (
    path: string,
    init: Record<string, unknown>
  ) => Promise<{ data?: unknown; error?: unknown; response: Response }>;
  const verbs = client as unknown as Record<string, VerbCall>;
  const { data, error, response } = await verbs[tool.method](tool.path, {
    params: { path: pathParams, query },
    ...(tool.hasBody && requestBody !== undefined ? { body: requestBody } : {}),
  });

  // Branch on the RESPONSE, not on `error`: openapi-fetch returns
  // `{ error: undefined }` for a non-OK response with an empty body
  // (Content-Length: 0 — a WAF/edge answering a bare 429/403/502 does this),
  // and treating that as success would tell the agent a failed call worked
  // and bypass the 401 onUnauthorized gate.
  if (!response.ok) return restError(response, error);
  return {
    ok: true,
    status: response.status,
    payload: data ?? { status: response.status },
  };
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null || value === '' || (Array.isArray(value) && !value.length)
  );
}

type Schema = Record<string, unknown>;

function asSchema(value: unknown): Schema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Schema)
    : undefined;
}

// Follows local `#/$defs/Name` refs. Depth-capped so a self-referencing
// definition cannot loop.
function resolveSchema(
  schema: unknown,
  defs: Record<string, unknown>,
  depth = 0
): Schema | undefined {
  const node = asSchema(schema);
  if (!node || depth > 16) return node;
  const ref = node.$ref;
  if (typeof ref === 'string' && ref.startsWith('#/$defs/'))
    return resolveSchema(defs[ref.slice('#/$defs/'.length)], defs, depth + 1);
  return node;
}

// Every schema that applies to a value: the node itself plus its allOf,
// anyOf and oneOf branches, refs resolved.
function branches(
  schema: unknown,
  defs: Record<string, unknown>,
  depth = 0
): Schema[] {
  const node = resolveSchema(schema, defs);
  if (!node || depth > 16) return [];
  const out = [node];
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    const list = node[key];
    if (Array.isArray(list))
      for (const sub of list) out.push(...branches(sub, defs, depth + 1));
  }
  return out;
}

function types(schemas: Schema[]): Set<string> {
  const out = new Set<string>();
  for (const s of schemas) {
    if (typeof s.type === 'string') out.add(s.type);
    else if (Array.isArray(s.type))
      for (const t of s.type) if (typeof t === 'string') out.add(t);
  }
  return out;
}

const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

export function coerceScalars(
  value: unknown,
  schema: unknown,
  defs: Record<string, unknown>,
  depth = 0
): unknown {
  if (depth > 32) return value;
  const applicable = branches(schema, defs);
  if (!applicable.length) return value;
  const allowed = types(applicable);

  if (typeof value === 'string') {
    // A string field stays a string even when it looks like a number.
    if (allowed.has('string')) return value;
    if (
      (allowed.has('integer') || allowed.has('number')) &&
      NUMERIC.test(value)
    ) {
      const n = Number(value);
      if (allowed.has('number') || Number.isInteger(n)) return n;
    }
    if (allowed.has('boolean') && (value === 'true' || value === 'false'))
      return value === 'true';
    return value;
  }

  if (Array.isArray(value)) {
    const items = applicable.map((s) => s.items).filter(Boolean);
    if (!items.length) return value;
    return value.map((item) =>
      coerceScalars(item, { anyOf: items }, defs, depth + 1)
    );
  }

  const object = asSchema(value);
  if (!object) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(object)) {
    const childSchemas: unknown[] = [];
    for (const s of applicable) {
      const props = asSchema(s.properties);
      if (props && key in props) childSchemas.push(props[key]);
      else if (asSchema(s.additionalProperties))
        childSchemas.push(s.additionalProperties);
    }
    out[key] = childSchemas.length
      ? coerceScalars(child, { anyOf: childSchemas }, defs, depth + 1)
      : child;
  }
  return out;
}
