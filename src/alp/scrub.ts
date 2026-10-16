// Best-effort secret redaction before forwarding to storage and again at the
// Convex write boundary. This catches recognizable tokens and sensitive config
// assignments; arbitrary unlabeled secrets cannot reliably be identified.
//
// Four stages, run in this order, each a pure function with its own table
// of rules and its own tests:
//
//   A. anchored credentials  — shapes recognizable on their own (rpa_, JWT...)
//   B. sensitive headers     — the WHOLE value of Authorization/Cookie/...
//   C. URL query secrets   — api_key/token/key/secret parameters
//   D. config assignments    — `key = value` / `key: value` by key name
//
// Specific before broad is the invariant. Several stage-A rules identify a
// credential by the word in front of it (`Bearer <opaque>`), and stage D stops
// an unquoted value at the first space or semicolon — so run in the other
// order, C consumes "Bearer", destroys the anchor, and leaves the secret in
// plaintext looking redacted. Stage B exists because header values are
// DEFINED by containing spaces and semicolons (`Basic <cred>`, `a=1; b=2`),
// which is exactly the shape the token-level matcher cannot hold whole.

export interface ScrubResult {
  text: string;
  /** How many redactions fired — a redaction rate is itself a metric. */
  redactions: number;
}

// Bump when any stage's rules change so stored rows record which pass they got.
export const SCRUB_VERSION = 5;

const MARKER = /^["']?\[redacted:[a-z_]+\]["']?$/;

// ---- Stage A: anchored credential shapes --------------------------------

const CREDENTIAL_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // Runpod API keys.
  { name: 'runpod_key', re: /\brpa_[A-Za-z0-9]{16,}\b/g },
  // Bearer credentials pasted with their header.
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  // Common vendor key prefixes.
  {
    name: 'vendor_key',
    re: /\b(?:sk|pk|ghp|gho|phc|phx|xoxb|xoxp)[-_][A-Za-z0-9_-]{16,}\b/g,
  },
  // Hugging Face access tokens.
  { name: 'hugging_face', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  // AWS access key ids.
  { name: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  // Three-segment JWTs.
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

export function redactAnchoredCredentials(text: string): ScrubResult {
  let redactions = 0;
  let out = text;
  for (const { name, re } of CREDENTIAL_PATTERNS) {
    out = out.replace(re, () => {
      redactions++;
      return `[redacted:${name}]`;
    });
  }
  return { text: out, redactions };
}

// ---- Stage B: sensitive headers, whole value ----------------------------

// Headers are matched wherever they appear, not only at line start: pastes
// arrive inline ("… got 401 with Authorization: Basic xyz | cookie: a=1; b=2")
// and the first version, anchored ^…$, missed exactly that and fell through
// to the token matcher — which redacted the word "Basic" and kept the
// credential. So the VALUE is bounded by its own shape rather than by the end
// of the line: an auth header is `<scheme> <token>` or a bare token; a cookie
// header is a `k=v; k=v` chain. Header names are case-insensitive.
const AUTH_HEADER =
  /\b((?:proxy-)?authorization|x-api-key|x-auth-token|x-runpod-token)(\s*:\s*)((?:basic|bearer|token|digest|negotiate|ntlm|apikey)\s+[^\s|,]+|[^\s|,]+)/gi;
const COOKIE_HEADER =
  /\b(cookie|set-cookie)(\s*:\s*)([^\s;=,|]+=[^\s;,|]*(?:\s*;\s*[^\s;=,|]+(?:=[^\s;,|]*)?)*)/gi;

export function redactHeaderValues(text: string): ScrubResult {
  let redactions = 0;
  const replace = (match: string, name: string, sep: string, value: string) => {
    // Stage A may already have replaced the value; keep its marker.
    if (MARKER.test(value)) return match;
    redactions++;
    return `${name}${sep}[redacted:header]`;
  };
  const out = text
    .replace(AUTH_HEADER, replace)
    .replace(COOKIE_HEADER, replace);
  return { text: out, redactions };
}

// ---- Stage C: URL query credentials -----------------------------------

// URL query credentials stop at the next query field, fragment or text boundary.
// Preserve parameter names and non-secret query fields for diagnostics.
export function redactQuerySecrets(text: string): ScrubResult {
  let redactions = 0;
  const out = text.replace(
    /([?&](?:api[_-]?key|access[_-]?token|token|key|secret)=)([^&#\s"'<>`]+)/gi,
    (match, prefix: string, value: string) => {
      if (MARKER.test(value)) return match;
      redactions++;
      return `${prefix}[redacted:query]`;
    }
  );
  return { text: out, redactions };
}

// ---- Stage D: config assignments, by key name ---------------------------

// Keys are compared segment by segment, never by substring: a substring test
// redacts `tokenizer: llama-3` because it contains "token". Split on
// separators AND camelCase, so `databasePassword` and `clientSecret` become
// segment lists rather than one opaque word.
const SENSITIVE_SEGMENTS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'cookie',
  'credential',
  'credentials',
]);

// `key` alone is too common to be sensitive (primary_key, cache_key). It
// counts when the segment right before it qualifies it — anywhere in the
// name, so SERVICE_API_KEY and STRIPE_ACCESS_KEY match, not only api_key.
const KEY_QUALIFIERS = new Set([
  'api',
  'access',
  'private',
  'signing',
  'secret',
  'client',
]);

export function splitKey(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.]+/)
    .filter(Boolean);
}

export function isSensitiveKey(key: string): boolean {
  const segments = splitKey(key);
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  return segments.some(
    (segment, i) =>
      (segment === 'key' && i > 0 && KEY_QUALIFIERS.has(segments[i - 1])) ||
      // No separator at all: `apikey`, `accesskey`.
      (segment.endsWith('key') && KEY_QUALIFIERS.has(segment.slice(0, -3)))
  );
}

// Covers JSON, YAML and shell env assignments, including quoted values with
// spaces or escaped quotes. The field name is kept for diagnostic context.
//
// This was one regex with a lookbehind, two quoted-string alternatives, a
// negated value class and a trailing lookahead. It was unreadable, and every
// fix to one case broke another: excluding `&` from the value class so a URL's
// second query parameter survived also truncated `password: p&ss#word123` at
// the `&` and leaked the rest. Both behaviors were correct for their own
// input and the character class had no way to tell the two apart, because the
// distinction is context, not characters.
//
// So the scan is written out: a cursor, one small function per token, and the
// value's terminator set chosen from where the key sits. Each rule below is a
// named predicate that can be read and tested on its own.

const QUOTES = new Set(['"', "'"]);

// A value always ends at one of these: `{`/`}` and `,`/`;` close a JSON or
// inline-YAML member, and a quote cannot appear inside an unquoted value.
const VALUE_TERMINATORS = new Set([',', ';', '{', '}', '"', "'"]);

// `&` and `#` end a value ONLY inside a URL query, where they begin the next
// parameter and the fragment. In a config file they are ordinary password
// characters — `p&ss#word` is one value, not three.
const QUERY_TERMINATORS = new Set(['&', '#']);

function isAsciiLetter(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** A key begins with a letter or underscore, never a digit — so `10:30` in a
 *  timestamp is not read as an assignment. */
function isKeyStart(ch: string): boolean {
  return isAsciiLetter(ch) || ch === '_';
}

/** Inside a key name: adds digits and the three separators that `splitKey`
 *  later splits on, so `aws.secretKey` and `DB_PASSWORD` arrive whole. */
function isKeyBody(ch: string): boolean {
  return (
    isAsciiLetter(ch) ||
    isAsciiDigit(ch) ||
    ch === '_' ||
    ch === '.' ||
    ch === '-'
  );
}

/** Horizontal space only. A newline after the separator means the value is on
 *  another line, so `db:\n  password: x` must not read `password` as db's
 *  value — the bug that let nested YAML through entirely. */
function isSpaceOrTab(ch: string): boolean {
  return ch === ' ' || ch === '\t';
}

function isWhitespace(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\n' ||
    ch === '\r' ||
    ch === '\f' ||
    ch === '\v'
  );
}

interface Assignment {
  /** Bare key name: quotes and the separator stripped. */
  key: string;
  /** Raw value text as it appears, including its quotes when quoted. */
  raw: string;
  /** Quote character to reinstate around a replacement, or `''`. */
  quote: string;
  /** Half-open range of the value within the source text. */
  start: number;
  end: number;
}

/** Reads a quoted value, honoring backslash escapes. An unterminated quote is
 *  a truncated paste, so it reads to the end of the line rather than giving
 *  up: for a redactor, over-reading a secret is the safe direction. */
function readQuotedValue(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (ch === '\n' || ch === '\r') return i;
    i++;
  }
  return text.length;
}

/** Reads an unquoted value up to the first terminator for its context. */
function readUnquotedValue(
  text: string,
  start: number,
  inQueryString: boolean
): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (isWhitespace(ch) || VALUE_TERMINATORS.has(ch)) break;
    if (inQueryString && QUERY_TERMINATORS.has(ch)) break;
    i++;
  }
  return i;
}

/** Parses `key: value` or `key = value` beginning at `at`, or null if there is
 *  no assignment there. */
function parseAssignment(text: string, at: number): Assignment | null {
  const before = at > 0 ? text[at - 1] : '';
  // Mid-identifier: `my_password` must not also match as key `password`.
  if (isKeyBody(before)) return null;

  let i = at;
  const openingQuote = QUOTES.has(text[i] ?? '') ? text[i] : '';
  if (openingQuote) i++;
  if (!isKeyStart(text[i] ?? '')) return null;

  const keyStart = i;
  while (i < text.length && isKeyBody(text[i])) i++;
  const key = text.slice(keyStart, i);

  // A closing quote is tolerated whether or not one opened: pasted snippets
  // arrive truncated, and `password": x` should still redact.
  if (QUOTES.has(text[i] ?? '')) i++;

  while (i < text.length && isSpaceOrTab(text[i])) i++;
  if (text[i] !== ':' && text[i] !== '=') return null;
  i++;
  while (i < text.length && isSpaceOrTab(text[i])) i++;

  // `?api_key=` or `&token=` — this key sits in a URL query string.
  const inQueryString = before === '?' || before === '&';

  const start = i;
  let end: number;
  let quote = '';
  if (QUOTES.has(text[start] ?? '')) {
    quote = text[start];
    end = readQuotedValue(text, start);
  } else {
    end = readUnquotedValue(text, start, inQueryString);
  }
  // A parent key such as `db:` has no value of its own.
  if (end === start) return null;

  return { key, raw: text.slice(start, end), quote, start, end };
}

export function redactAssignments(text: string): ScrubResult {
  let redactions = 0;
  let out = '';
  let copiedTo = 0;
  let cursor = 0;

  while (cursor < text.length) {
    const found = parseAssignment(text, cursor);
    if (!found) {
      cursor++;
      continue;
    }

    // Already handled by an earlier stage — keep its marker, do not count it
    // twice, and resume past it.
    if (MARKER.test(found.raw)) {
      cursor = found.end;
      continue;
    }

    if (!isSensitiveKey(found.key)) {
      // Resume INSIDE the value, not after it. A non-sensitive assignment can
      // contain one: `https://h/?password=x` parses as key `https` whose value
      // is the whole URL, and skipping it leaked the password outright.
      cursor = found.start;
      continue;
    }

    out += text.slice(copiedTo, found.start);
    out += `${found.quote}[redacted:config]${found.quote}`;
    copiedTo = found.end;
    cursor = found.end;
    redactions++;
  }

  out += text.slice(copiedTo);
  return { text: out, redactions };
}

// ---- Composition ---------------------------------------------------------

export function scrub(text: string): ScrubResult {
  let out = text;
  let redactions = 0;
  for (const stage of [
    redactAnchoredCredentials,
    redactHeaderValues,
    redactQuerySecrets,
    redactAssignments,
  ]) {
    const result = stage(out);
    out = result.text;
    redactions += result.redactions;
  }
  return { text: out, redactions };
}

// Only user-authored text is scrubbed; resolved identity and server timestamps
// remain authoritative. Reapplying this at the sink is safe and idempotent.
export const SCRUBBED_FIELDS = [
  'content',
  'intention',
  'modelType',
  'severity',
  'tool',
  'workaround',
  'trigger',
  'source',
  'harness',
  'harnessSource',
  'transport',
] as const;

export function scrubSubmission<
  T extends {
    content: string;
    intention?: string;
    modelType?: string;
    severity?: string;
    tool?: string;
    workaround?: string;
    trigger?: string;
    source?: string;
    harness?: string;
    harnessSource?: string;
    transport?: string;
    redactions: number;
    scrubVersion: number;
  },
>(row: T): T {
  const clean = { ...row };
  // EVERY agent-writable string field belongs in this list. A field added to
  // the submission shape but not here is stored unscrubbed, which is how a
  // pasted credential reaches the table — the fields most likely to carry one
  // are exactly the free-text ones a new route adds. Guarded by a test that
  // walks the submission type, so the omission fails CI rather than shipping.
  for (const field of SCRUBBED_FIELDS) {
    const value = clean[field];
    if (typeof value !== 'string') continue;
    const result = scrub(value);
    clean[field] = result.text;
    clean.redactions += result.redactions;
  }
  clean.scrubVersion = SCRUB_VERSION;
  return clean;
}
