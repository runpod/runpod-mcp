// Courtesy secret scrub for ALP submissions, applied in the public ingest
// path before anything is stored or forwarded. This is deliberately the
// SHALLOW pass: well-known, high-confidence credential shapes only. The
// authoritative ruleset runs on the private sink side (see
// docs/agent-learning-protocol.md — publishing a thorough ruleset tells
// anyone exactly what evades it), so this file only needs to catch the
// obvious pastes, not win an arms race.

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
export const SCRUB_VERSION = 1;

export interface ScrubResult {
  text: string;
  /** How many redactions fired — a redaction rate is itself a metric. */
  redactions: number;
}

export function scrub(text: string): ScrubResult {
  let redactions = 0;
  let out = text;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, () => {
      redactions++;
      return `[redacted:${name}]`;
    });
  }
  return { text: out, redactions };
}
