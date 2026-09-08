// Best-effort secret redaction before forwarding to storage and again at the
// Convex write boundary. This catches recognizable tokens and sensitive config
// assignments; arbitrary unlabeled secrets cannot reliably be identified.

const PATTERNS: Array<{ name: string; re: RegExp }> = [
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

// Bump when PATTERNS changes so stored rows record which pass they got.
export const SCRUB_VERSION = 2;

export interface ScrubResult {
  text: string;
  /** How many redactions fired — a redaction rate is itself a metric. */
  redactions: number;
}

// Assignment keys are compared segment by segment, not by substring: a
// substring test redacts `tokenizer: llama-3` because it contains "token".
// `key` on its own is too common to treat as sensitive, so it counts only
// when qualified (api_key, access_key, private_key, apikey).
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

function isSensitiveKey(key: string): boolean {
  // Split on separators AND camelCase boundaries, so `databasePassword` and
  // `clientSecret` are seen as segment lists rather than one opaque word.
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_\-.]+/);
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  // `key` alone is too common; it counts only when qualified.
  return /^(?:api|access|private|signing)[_-]?key$/i.test(segments.join('_'));
}

export function scrub(text: string): ScrubResult {
  let redactions = 0;
  // The anchored patterns run FIRST, and the order is the whole point. Several
  // of them recognize a credential by the token that precedes it — `bearer`
  // matches `Bearer <opaque>`, not the opaque part alone. The assignment pass
  // below stops an unquoted value at the first space, so running it first
  // rewrote `Authorization: Bearer <opaque>` to `[redacted:config] <opaque>`:
  // it consumed the word "Bearer", destroyed the anchor, and left the secret
  // in plaintext. Redacting the specific shapes first leaves nothing for the
  // broad pass to half-match.
  let out = text;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, () => {
      redactions++;
      return `[redacted:${name}]`;
    });
  }
  // Covers JSON, YAML and shell env assignments, including quoted values
  // with spaces or escaped quotes. Keep the field name for diagnostic context.
  const assignment =
    /(?<![A-Za-z0-9_.-])(["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;{}"']+)(?=\s|[,;}]|$)/g;
  out = out.replace(assignment, (match, prefix: string, value: string) => {
    const key = prefix.replace(/["'\s:=]/g, '');
    if (!isSensitiveKey(key)) return match;
    // Already handled by the anchored pass above — do not count it twice.
    if (/^["']?\[redacted:[a-z_]+\]["']?$/.test(value)) return match;
    redactions++;
    const quote = value.startsWith('"')
      ? '"'
      : value.startsWith("'")
        ? "'"
        : '';
    return `${prefix}${quote}[redacted:config]${quote}`;
  });
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
