// The `jmespath` argument of list tools: filter rows, choose columns and sort,
// before paging. docs/list-queries.md explains it; this file checks an
// expression before any API call and runs it on rows.
//
// Only forms that keep rows independent are accepted, so a list read in
// pieces (one API page at a time) gives exactly what the whole list would:
//   [?cond]   [?cond].{k: expr, ...}   [].{...} / [*].{...}       row by row
//   sort_by(<any of those, or @>, &key), optionally inside reverse()   whole list
// Everything an agent could get wrong silently (a misspelled field, an enum
// value that does not exist, a quoted number) is a 400 that says how to fix
// it, because a silent "no rows" reads as a true answer.

import { compile, search, type JmespathNode } from 'jmespath';
import { redactSecretEnv } from './redact.js';

export const JMESPATH_MAX_LENGTH = 500;

// The argument every queryable list takes. SERVER_INSTRUCTIONS explains the
// forms once, so this stays short in every tool definition (37 of them); the
// length limit is checked in compileListQuery, not declared here.
export const listJmespathProperty = {
  type: 'string',
  description:
    'JMESPath filter/columns/sort on the rows; fields: describe-tool.',
};

/** A list row's shape, generated from the API spec (specgen/generator). */
export interface RowSchema {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, RowSchema>;
  items?: RowSchema;
  /** Any keys allowed (an env map): fields below it are not checked. */
  open?: true;
}

/** Every field of a row as `path: type`, for describe-tool: enums as
 *  `A | B`, array items as `tags[].key`, free-form maps as `object (any keys)`. */
export function rowFields(
  schema: RowSchema,
  prefix = ''
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [name, field] of Object.entries(schema.properties ?? {})) {
    const path = prefix + name;
    fields[path] = field.enum
      ? field.enum.map(String).join(' | ')
      : field.open
        ? 'object (any keys)'
        : field.type === 'array' && field.items?.type && !field.items.properties
          ? `array of ${field.items.enum ? field.items.enum.map(String).join(' | ') : field.items.type}`
          : (field.type ?? 'any');
    Object.assign(
      fields,
      field.type === 'array' && field.items?.properties
        ? rowFields(field.items, `${path}[].`)
        : rowFields(field, `${path}.`)
    );
  }
  return fields;
}

/** The schema of rows trimmed to `fields` (the hand-written lists). */
export const pickFields = (
  schema: RowSchema,
  fields: readonly string[]
): RowSchema => ({
  type: 'object',
  properties: Object.fromEntries(
    fields.map((field) => [field, schema.properties?.[field] ?? {}])
  ),
});

export type QueryError = {
  ok: false;
  status: 400;
  payload: Record<string, unknown>;
};

export interface ListQuery {
  /** 'rows': each row is matched on its own; 'sorted': needs the whole list. */
  mode: 'rows' | 'sorted';
  /** Row mode: the row's output, or undefined when it does not match. */
  match(row: unknown): { ok: true; out?: Record<string, unknown> } | QueryError;
  /** Sorted mode (and lists held whole): the expression over every row. */
  run(
    rows: unknown[]
  ): { ok: true; rows: Record<string, unknown>[] } | QueryError;
}

const FORMS =
  'Accepted forms: [?cond], [?cond].{name: field, ...}, [].{name: field, ...}, and sort_by(<one of those, or @>, &field), optionally inside reverse(...).';

const fail = (
  error: string,
  hint: string,
  extra: Record<string, unknown> = {}
): QueryError => ({
  ok: false,
  status: 400,
  payload: { code: 'invalid_jmespath', error, hint, ...extra },
});

// The library looks fields and functions up without an own-property check:
// `[?env.constructor]` would match every row. No row field is named like
// this, so these names are refused everywhere, even under free-form maps.
const BUILT_IN_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

// The JMESPath standard's functions, as jmespath 0.16.0 has them.
const FUNCTIONS = new Set([
  'abs',
  'avg',
  'ceil',
  'contains',
  'ends_with',
  'floor',
  'join',
  'keys',
  'length',
  'map',
  'max',
  'max_by',
  'merge',
  'min',
  'min_by',
  'not_null',
  'reverse',
  'sort',
  'sort_by',
  'starts_with',
  'sum',
  'to_array',
  'to_number',
  'to_string',
  'type',
  'values',
]);

// Pipe and multi-select lists are the only ways to multiply the output
// (`[@, @] | [@, @] ...`); nothing a row filter needs.
const NODES = new Set([
  'Field',
  'Subexpression',
  'Identity',
  'Current',
  'Literal',
  'Index',
  'IndexExpression',
  'Slice',
  'Flatten',
  'Projection',
  'ValueProjection',
  'FilterProjection',
  'Comparator',
  'AndExpression',
  'OrExpression',
  'NotExpression',
  'Function',
  'ExpressionReference',
  'MultiSelectHash',
  'KeyValuePair',
]);

const kids = (node: JmespathNode): JmespathNode[] =>
  (node.children ?? []).filter(
    (child): child is JmespathNode =>
      typeof child === 'object' && child !== null
  );

// [?cond], [?cond].{...}, [].{...}, [*].{...}, [*], []: every output comes
// from one row.
function isRowForm(node: JmespathNode): boolean {
  const [left, right] = kids(node);
  const fromRows =
    left?.type === 'Identity' ||
    (left?.type === 'Flatten' && kids(left)[0]?.type === 'Identity');
  if (node.type === 'FilterProjection')
    return (
      left?.type === 'Identity' &&
      (right?.type === 'Identity' || right?.type === 'MultiSelectHash')
    );
  return (
    node.type === 'Projection' &&
    fromRows &&
    (right?.type === 'MultiSelectHash' || right?.type === 'Identity')
  );
}

function modeOf(root: JmespathNode): ListQuery['mode'] | undefined {
  if (isRowForm(root)) return 'rows';
  const sortBy =
    root.type === 'Function' && root.name === 'reverse' ? kids(root)[0] : root;
  if (sortBy?.type !== 'Function' || sortBy.name !== 'sort_by') return;
  const [rows, key] = kids(sortBy);
  return rows &&
    (rows.type === 'Current' || isRowForm(rows)) &&
    key?.type === 'ExpressionReference' &&
    sortBy.children?.length === 2 &&
    (root === sortBy || root.children?.length === 1)
    ? 'sorted'
    : undefined;
}

// `gpu.id` for a plain field path; undefined for anything else.
function fieldPath(node: JmespathNode): string | undefined {
  if (node.type === 'Field') return node.name;
  if (node.type !== 'Subexpression') return;
  const [left, right] = kids(node).map(fieldPath);
  return left && right ? `${left}.${right}` : undefined;
}

const SCALARS = new Set(['string', 'number', 'boolean']);

const LIST_HINT =
  "Filter a list's items instead: [?tags[?key=='team']], or for a list of text [?contains(ports, '8888/http')].";

// Walks the expression with the schema of the value each node reads, and
// returns the schema of what it produces (undefined: unknown, not checked).
class SchemaCheck {
  error?: QueryError;

  read(node: JmespathNode, at: RowSchema | undefined): RowSchema | undefined {
    if (this.error) return;
    const [a, b, c] = kids(node);
    switch (node.type) {
      case 'Field':
        return this.field(node.name ?? '', at);
      case 'Subexpression':
        return this.read(b, this.read(a, at));
      case 'Identity':
      case 'Current':
        return at;
      case 'Flatten': {
        const inner = this.read(a, at);
        return inner?.items?.type === 'array' ? inner.items : inner;
      }
      case 'IndexExpression': {
        const inner = this.read(a, at);
        return b?.type === 'Index' ? inner?.items : inner;
      }
      case 'Projection':
        return this.list(this.read(b, this.read(a, at)?.items));
      case 'ValueProjection':
        this.read(a, at);
        this.read(b, undefined);
        return;
      case 'FilterProjection': {
        const item = this.read(a, at)?.items;
        this.read(c, item);
        return this.list(this.read(b, item));
      }
      case 'Comparator':
        this.compare(a, b, at);
        return { type: 'boolean' };
      case 'Function':
        return this.call(node, at);
      case 'MultiSelectHash':
        return {
          type: 'object',
          properties: Object.fromEntries(
            kids(node).map((pair) => [
              pair.name ?? '',
              this.read(pair.value as JmespathNode, at) ?? {},
            ])
          ),
        };
      case 'ExpressionReference':
        this.read(a, undefined);
        return;
      default:
        for (const child of kids(node)) this.read(child, at);
        return;
    }
  }

  private list(items: RowSchema | undefined): RowSchema {
    return { type: 'array', ...(items ? { items } : {}) };
  }

  private field(name: string, at: RowSchema | undefined) {
    if (!at || at.open) return;
    // A dot on a list is null in JMESPath: tags.key never matches anything.
    if (at.type === 'array') {
      this.error = fail(
        `'${name}' is read from a list, where it is always null.`,
        LIST_HINT
      );
      return;
    }
    if (at.properties) {
      if (Object.hasOwn(at.properties, name)) return at.properties[name];
      const fields = Object.keys(at.properties);
      this.error = fail(
        `Unknown field '${name}'. Fields here: ${fields.join(', ')}.`,
        "Use a field from the list (describe-tool shows every field of this list with its type). Quote string values: 'RUNNING', not RUNNING.",
        { fields }
      );
      return;
    }
    if (at.type && SCALARS.has(at.type))
      this.error = fail(
        `'${name}' is read from a ${at.type}, which has no fields.`,
        'describe-tool shows each field of this list and its type.'
      );
  }

  // A field compared with a literal: the literal must fit the field.
  private compare(
    left: JmespathNode,
    right: JmespathNode,
    at: RowSchema | undefined
  ) {
    const sides = [left, right].map((node) => ({
      node,
      schema: this.read(node, at),
    }));
    if (this.error) return;
    const literal = sides.find((side) => side.node.type === 'Literal');
    if (!literal || literal.node.value === null) return;
    // A list compared with one value is never equal: ports == '8888/http'.
    const list = sides.find((side) => side.schema?.type === 'array');
    if (list && typeof literal.node.value !== 'object') {
      this.error = fail(
        `${fieldPath(list.node) ?? 'This side'} is a list, compared here with one value, which never matches.`,
        LIST_HINT
      );
      return;
    }
    // The other side, by schema, not by whether it has a printable name: an
    // indexed path (tags[0].key) has a perfectly good schema here but no
    // dotted name, and skipping it on that account let a type mismatch
    // through unchecked.
    const field = sides.find((side) => side !== literal);
    if (!field?.schema) return;
    const value = literal.node.value;
    const { schema } = field;
    const name = fieldPath(field.node) ?? 'This side';
    if (schema.enum && !schema.enum.includes(value)) {
      this.error = fail(
        `${name} is never ${JSON.stringify(value)}. Its values: ${schema.enum.map(String).join(', ')}.`,
        'Compare with one of these values, in single quotes.',
        { allowed: schema.enum }
      );
      return;
    }
    if (schema.type === 'number' && typeof value === 'string')
      this.error = fail(
        `${name} is a number, compared here with the text '${value}'.`,
        `Write numbers in backticks: \`${value}\`.`
      );
    else if (schema.type === 'string' && typeof value === 'number')
      this.error = fail(
        `${name} is text, compared here with the number ${value}.`,
        `Write text in single quotes: '${value}'.`
      );
    else if (schema.type === 'boolean' && typeof value !== 'boolean')
      this.error = fail(
        `${name} is true or false, compared here with ${JSON.stringify(value)}.`,
        'Write `true` or `false` in backticks.'
      );
    else if (schema.type === 'number' && typeof value === 'boolean')
      this.error = fail(
        `${name} is a number, compared here with ${value}.`,
        'Write a number in backticks, not true/false.'
      );
    else if (schema.type === 'string' && typeof value === 'boolean')
      this.error = fail(
        `${name} is text, compared here with ${value}.`,
        'Write text in single quotes, not true/false.'
      );
  }

  // sort_by, max_by and min_by run their &key on each item of their array
  // argument; map takes the same two parts in reverse order (&expr, then the
  // array), so its array is checked here against the row the same way, and
  // its expression against that array's item schema, once it is known.
  private call(node: JmespathNode, at: RowSchema | undefined) {
    const [first, second] = kids(node);
    const name = node.name ?? '';
    if (name === 'map' && first?.type === 'ExpressionReference' && second) {
      const rows = this.read(second, at);
      // map's output items are what its expression produces per item, not
      // the input array's own item shape: a missing array (an arity error,
      // left for the runtime's own error, not reproduced here) leaves this
      // unchecked, at undefined, same as any other unresolvable schema.
      const mapped = this.read(kids(first)[0], rows?.items);
      return this.list(mapped);
    }
    if (
      ['sort_by', 'max_by', 'min_by'].includes(name) &&
      second?.type === 'ExpressionReference'
    ) {
      const rows = this.read(first, at);
      this.read(kids(second)[0], rows?.items);
      return name === 'sort_by' ? rows : rows?.items;
    }
    const results = kids(node).map((child) => this.read(child, at));
    return name === 'reverse' ? results[0] : undefined;
  }
}

function walk(node: JmespathNode, visit: (node: JmespathNode) => void) {
  visit(node);
  for (const child of kids(node)) walk(child, visit);
  if (node.type === 'KeyValuePair' && node.value)
    walk(node.value as JmespathNode, visit);
}

/** Checks `expression` against the list's rows; undefined when omitted.
 *  `rowsKey` is the result key the rows come back under (`pods`): agents
 *  often start from it (`pods[?status=='RUNNING']`), as other servers'
 *  JMESPath arguments expect, so a leading rows key is dropped. */
export function compileListQuery(
  expression: unknown,
  schema: RowSchema,
  rowsKey?: string
): { ok: true; query?: ListQuery } | QueryError {
  if (expression === undefined || expression === null || expression === '')
    return { ok: true };
  if (typeof expression !== 'string')
    return fail('jmespath must be a string.', FORMS);
  // Checked on what was actually sent, before the rows-key strip below: that
  // strip only ever drops a short, fixed token (the rows key's own name), so
  // checking the normalized text instead let a submission longer than the
  // limit through by padding around a redundant rows key.
  if (expression.length > JMESPATH_MAX_LENGTH)
    return fail(
      `jmespath is ${expression.length} characters; the limit is ${JMESPATH_MAX_LENGTH}.`,
      'Shorten it: choose fewer columns, or filter on fewer conditions.'
    );
  let text = expression;
  if (rowsKey && !Object.hasOwn(schema.properties ?? {}, rowsKey)) {
    // pods[...] -> [...], sort_by(pods, ...) -> sort_by(@, ...)
    const lead = '^(\\s*(?:reverse\\(\\s*)?(?:sort_by\\(\\s*)?)';
    text = text
      .replace(new RegExp(`${lead}${rowsKey}(?=\\s*\\[)`), '$1')
      .replace(new RegExp(`${lead}${rowsKey}(?=\\s*,)`), '$1@');
  }
  let root: JmespathNode;
  try {
    root = compile(text);
  } catch (error) {
    return fail(
      `Not a valid JMESPath expression: ${(error as Error).message}`,
      `${FORMS} Text goes in single quotes ('RUNNING'), numbers and true/false in backticks (\`0.5\`).`
    );
  }
  let refused: QueryError | undefined;
  walk(root, (node) => {
    if (refused) return;
    if (!NODES.has(node.type))
      refused = fail(
        `${node.type === 'Pipe' ? 'A pipe (|)' : node.type === 'MultiSelectList' ? 'A list of values ([a, b])' : node.type} is not supported in jmespath.`,
        node.type === 'MultiSelectList'
          ? `To match one of several values: [?status=='RUNNING' || status=='STARTING']. ${FORMS}`
          : FORMS
      );
    else if (node.type === 'Function' && !FUNCTIONS.has(node.name ?? ''))
      refused = fail(
        `Unknown function ${node.name}().`,
        `Functions: ${[...FUNCTIONS].join(', ')}.`
      );
    else if (node.type === 'Field' && BUILT_IN_NAMES.has(node.name ?? ''))
      refused = fail(
        `'${node.name}' is not a field of this list.`,
        'describe-tool shows every field of this list.'
      );
    else if (
      node.type === 'KeyValuePair' &&
      BUILT_IN_NAMES.has(node.name ?? '')
    )
      refused = fail(
        `'${node.name}' cannot be an output column: it is a built-in object property, and the row would silently drop it.`,
        'Pick another name.'
      );
  });
  if (refused) return refused;
  const mode = modeOf(root);
  if (!mode)
    return fail(
      root.type === 'Projection' || root.type === 'FilterProjection'
        ? 'This expression returns single values, not rows.'
        : 'This expression does not return rows of this list.',
      `${FORMS} To keep one column, name it: [?cond].{id: id}. Counts are pagination.total; the first N rows are limit: N.`
    );
  const check = new SchemaCheck();
  check.read(root, { type: 'array', items: schema });
  if (check.error) return check.error;
  return { ok: true, query: listQuery(text, mode) };
}

// jmespath 0.16.0 reports a sort key of the wrong type as "TypeError" or
// "TypeError: expected 0, received 7" (its internal type codes).
function runtimeError(error: unknown): QueryError {
  const message = String((error as Error)?.message ?? error);
  if (/^TypeError(: expected \d+, received \d+)?$/.test(message))
    return fail(
      'sort_by needs a key of one type, number or text, in every row; some rows have no value there (null) or another type.',
      'Filter those rows out first, with your sort field: sort_by([?field != `null`], &field).'
    );
  return fail(
    `The expression failed on a row: ${message.replace(/^TypeError: /, '')}`,
    /received type null/.test(message)
      ? "A field is missing (null) on some rows: guard it, e.g. [?name && starts_with(name, 'x')]."
      : 'Check the argument types: text in single quotes, numbers and true/false in backticks.'
  );
}

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Columns choose fields; no output row may be bigger than the biggest row
// of the list. This bounds every way to multiply one row ({a: @, b: @,
// ...}): fittingRows always keeps at least one row, however big, so a row
// built bigger than any real row would still be sent alone, past the page
// budget. Comparing the whole output against the whole input (as this once
// did) misses a filter that drops most rows and lets the few survivors
// balloon into the size that frees up; comparing each surviving row
// against the single largest input row does not.
const LARGER = fail(
  'This expression makes rows larger than the rows of the list.',
  'Name each field once in the columns, and do not copy the whole row (@) into a column.'
);
// Bytes, matching how the page budget itself is measured (pagination.ts's
// resultBytes): .length counts UTF-16 code units, which undercounts any
// multi-byte text, letting a column-duplication expression on CJK or emoji
// text pass this guard while still growing the real page past its budget.
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const largerThanAny = (rows: unknown[], most: number) =>
  rows.some((row) => size(row) > most);

function listQuery(expression: string, mode: ListQuery['mode']): ListQuery {
  // Secret env values are blanked before the expression sees a row, so a
  // filter cannot test a secret one character at a time.
  return {
    mode,
    match(row) {
      try {
        const input = redactSecretEnv(row);
        const [out] = search([input], expression) as unknown[];
        if (out === undefined) return { ok: true };
        if (!isRow(out))
          return fail(
            'The expression returned a value that is not a row.',
            FORMS
          );
        return largerThanAny([out], size(input)) ? LARGER : { ok: true, out };
      } catch (error) {
        return runtimeError(error);
      }
    },
    run(rows) {
      try {
        const input = redactSecretEnv(rows) as unknown[];
        const out = search(input, expression);
        if (!Array.isArray(out) || !out.every(isRow))
          return fail(
            'The expression returned values that are not rows.',
            FORMS
          );
        const most = Math.max(0, ...input.map(size));
        return largerThanAny(out, most) ? LARGER : { ok: true, rows: out };
      } catch (error) {
        return runtimeError(error);
      }
    },
  };
}
