// Best-effort secret redaction before forwarding to storage and again at the
// Convex write boundary. This catches recognizable tokens and sensitive config
// assignments; arbitrary unlabeled secrets cannot reliably be identified.
//
// Three stages, run in this order, each a pure function with its own table
// of rules and its own tests:
//
//   A. anchored credentials  — shapes recognizable on their own (rpa_, JWT...)
//   B. sensitive headers     — the WHOLE value of Authorization/Cookie/...
//   C. config assignments    — `key = value` / `key: value` by key name
//
// Specific before broad is the invariant. Several stage-A rules identify a
// credential by the word in front of it (`Bearer <opaque>`), and stage C stops
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
export const SCRUB_VERSION = 3;

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

// ---- Stage C: config assignments, by key name ---------------------------

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
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])(["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;{}"']+)(?=\s|[,;}]|$)/g;

export function redactAssignments(text: string): ScrubResult {
  let redactions = 0;
  const out = text.replace(
    ASSIGNMENT,
    (match, prefix: string, value: string) => {
      const key = prefix.replace(/["'\s:=]/g, '');
      if (!isSensitiveKey(key)) return match;
      // Already handled by an earlier stage — do not count it twice.
      if (MARKER.test(value)) return match;
      redactions++;
      const quote = value.startsWith('"')
        ? '"'
        : value.startsWith("'")
          ? "'"
          : '';
      return `${prefix}${quote}[redacted:config]${quote}`;
    }
  );
  return { text: out, redactions };
}

// ---- Composition ---------------------------------------------------------

export function scrub(text: string): ScrubResult {
  let out = text;
  let redactions = 0;
  for (const stage of [
    redactAnchoredCredentials,
    redactHeaderValues,
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
export function scrubSubmission<
  T extends {
    content: string;
    intention?: string;
    modelType?: string;
    harness?: string;
    harnessSource?: string;
    transport?: string;
    redactions: number;
    scrubVersion: number;
  },
>(row: T): T {
  const clean = { ...row };
  for (const field of [
    'content',
    'intention',
    'modelType',
    'harness',
    'harnessSource',
    'transport',
  ] as const) {
    const value = clean[field];
    if (typeof value !== 'string') continue;
    const result = scrub(value);
    clean[field] = result.text;
    clean.redactions += result.redactions;
  }
  clean.scrubVersion = SCRUB_VERSION;
  return clean;
}
