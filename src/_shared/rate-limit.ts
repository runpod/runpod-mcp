// ============== 429 RATE-LIMIT HINT ==============
// A 429's bare "rate limit exceeded" invites the worst possible agent
// response: retrying immediately. This turns one into a wait instruction,
// reading the IETF `RateLimit` field and `Retry-After`. Kept out of the HTTP
// client because it shares nothing with it — two strings in, one string out —
// and because both the client and the SSE log reader need it.

// No window names or numbers here: this same client serves the serverless host
// (api.runpod.ai), whose quota shape this repo doesn't document, so naming
// minute/hour/day windows would assert a REST fact somewhere it may not hold.
const GENERIC_RATE_LIMIT_HINT =
  'rate limited — back off before retrying, and pace bulk operations';

// The longest window this API documents is a day; the slack covers an
// undocumented serverless policy without printing "~1157407408 days" for a
// broken or hostile header, which the digit count alone would not bound.
// Rejecting is cheap either way: a discarded reset never shortens the wait —
// it hedges it when another source still answers, and otherwise leaves the
// "no usable reset time" clause to say so outright.
const MAX_PLAUSIBLE_WAIT_S = 7 * 86400;

// One window reporting zero requests left. `window` is null when the name was
// unreadable — the reset is independently trustworthy, and dropping the item
// would throw away a correct number to avoid printing a doubtful name.
// `resetS` is null when the window sent no readable `t`: the parameter is
// optional, and a value that is unparseable (`t=1.5`), implausible (past the
// cap) or valueless (`t` alone) all read the same way — absent. The member
// still counts, because its `r` is what said the window is out.
interface ExhaustedWindow {
  window: string | null;
  resetS: number | null;
}

// A count of remaining requests. Only ever compared against zero, so its
// magnitude doesn't matter — but blank must not pass: `Number('')` is 0, which
// would read `"hour";r=;t=` as a real exhausted window.
function remainingRequests(raw: string | undefined): number | null {
  const value = raw?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

// A number of seconds to wait, from `t` or from `Retry-After`. Both are plain
// digit strings — `1.5`, `-30`, `0x10` and `1e3` are not, and `Number()` would
// happily coerce every one of them.
function waitSeconds(raw: string | null | undefined): number | null {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return seconds <= MAX_PLAUSIBLE_WAIT_S ? seconds : null;
}

// A window name, or null if it isn't one. The name lands verbatim in an error
// message an agent reads, so validate rather than sanitize — including its
// length. Truncating would print a name that isn't in the header, which is the
// same defect as stripping the parts that don't belong: `"a,b"` reported as
// "the b quota". A quoted name takes any UNESCAPED string character, so
// `"gpu hour"` is named rather than dropped; a `\`-escape or a display string
// is legal but unsupported, and dropping the name beats printing one we
// haven't unescaped. Bare names follow the token grammar.
const WINDOW_NAME_RE =
  /^(?:"([\x20-\x21\x23-\x5b\x5d-\x7e]{1,32})"|([A-Za-z*][A-Za-z0-9!#$%&'*+.^_`|~:/-]{0,31}))$/;
function windowName(raw: string): string | null {
  const match = WINDOW_NAME_RE.exec(raw.trim());
  return match ? (match[1] ?? match[2]) : null;
}

// A parameter value that is a complete quoted string and nothing else. Testing
// only the first and last character would pass `pk="x" "minute"`, where a
// second item was glued on after a legal value — the same merge as below, one
// quote further along.
const QUOTED_VALUE_RE = /^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"$/;
// A display string is a legal parameter value too (`%"caf%c3%a9"`). Reading it
// as malformed would silently collapse every hint on the day the API adds one,
// which is the failure this file exists to avoid — so match it, still whole.
const DISPLAY_VALUE_RE =
  /^%"(?:[\x20-\x21\x23-\x24\x26-\x5b\x5d-\x7e]|\\|%[0-9a-f]{2})*"$/;

// Whether a `;`-separated chunk is a well-formed parameter. A dropped comma
// glues the next item onto the previous parameter's VALUE — `t=3600 "minute"`,
// or `t=3600 minute` in the token form — and last-wins then merges the two
// items under the FIRST one's name and the SECOND one's reset, which is how a
// 3600s lockout gets answered with "wait ~10s". A bare value can hold no
// whitespace (every unquoted item type excludes it) and no quote, so either
// means two items ran together. The draft says a malformed field MUST be
// ignored wholesale; dropping just the item keeps more signal and still never
// over-reports, because `dropped` forces the "at least".
function isWellFormedParam(param: string): boolean {
  const eq = param.indexOf('=');
  const key = (eq === -1 ? param : param.slice(0, eq)).trim();
  if (key.includes('"')) return false;
  if (eq === -1) return true;
  const value = param.slice(eq + 1).trim();
  if (value.startsWith('"')) return QUOTED_VALUE_RE.test(value);
  if (value.startsWith('%"')) return DISPLAY_VALUE_RE.test(value);
  return !/[\s"]/.test(value);
}

// Split on `sep` only where it isn't inside a quoted string. A plain
// `String.split` cuts `"a,b";r=0;t=1812` — a legal window name — in half,
// losing that window's r/t entirely, and if a shorter window survives alongside
// it the hint confidently reports the shorter wait. Same for a vendor parameter
// the draft leaves untyped (`acme-scope="a,b"`). Strings are the only construct
// that can hide a delimiter: `pk` is a byte sequence (`pk=:QXBwLTk5OQ==:`),
// whose base64 alphabet holds neither. An unterminated quote yields one chunk,
// which then fails validation — as a name if the quote opened in the name
// position, as a parameter otherwise. Malformed in, generic out.
function splitOutsideStrings(input: string, sep: ',' | ';'): string[] {
  const parts: string[] = [];
  let current = '';
  let inString = false;
  // A display string opens with `%"`, and inside one a backslash is a literal
  // character rather than an escape — treating it as an escape would eat the
  // closing quote and swallow the rest of the field.
  let inDisplay = false;
  let escaped = false;
  let prev = '';
  for (const ch of input) {
    if (escaped) escaped = false;
    else if (inString && !inDisplay && ch === '\\') escaped = true;
    else if (ch === '"') {
      if (!inString) inDisplay = prev === '%';
      inString = !inString;
    } else if (ch === sep && !inString) {
      parts.push(current);
      current = '';
      prev = ch;
      continue;
    }
    current += ch;
    prev = ch;
  }
  parts.push(current);
  return parts;
}

// Split-based rather than one regex: the field is a structured-field list, so
// params may be reordered (`"hour";t=1724;r=0`), spaced, or carry unknown
// vendor keys, and `t` may be absent — a pattern pinned to `r=<n>;t=<n>` yields
// nothing on variants that mean the same thing, and silence here costs the
// specifics exactly when they matter. Never throws.
//
// `dropped` reports whether anything was thrown away unread — only a malformed
// item, since an unreadable name keeps its numbers. It has to reach the caller:
// otherwise a discarded `r=0;t=3600` lets a readable 10-second sibling answer
// as if it were the whole truth.
interface ParsedWindows {
  windows: ExhaustedWindow[];
  dropped: boolean;
}

// A member's parameters, and whether reading them left `r` or `t` unreadable.
// Three tells, the first two being shapes a lost comma produces:
//   - a valueless parameter FOLLOWED BY `r` or `t`. Valueless is the only legal
//     way to send a Boolean-true flag (RFC 9651 §3.1.2: a true value MUST be
//     omitted), but it is also exactly what a glued bare-token name looks like —
//     `"minute";t=10;hour;r=0` is one item with an `hour` flag, or two items and
//     a lost comma, and nothing in the field tells them apart. Only a number
//     AFTER the flag can have been misattributed, so a trailing flag
//     (`"hour";r=0;t=3600;acme-flag`) costs nothing and is kept.
//   - `r` or `t` twice. RFC 9651's note on parsing parameters — "when duplicate
//     parameter keys are encountered, all but the last instance are ignored" —
//     carries no RFC 2119 keyword, and `minute;r=0;t=2876;minute;r=0;t=1641` is
//     the same glue, where last-wins answers a 2876s lockout with 1641s.
//   - `r` or `t` sent valueless at all, glue or not. A bare flag is Boolean
//     true, so `"hour";r=0;t` states no reset and `"hour";r=0;r` never says
//     the window is out — the value simply isn't there to read.
// In every case we can't say what the number is, or whether it is ours, so
// don't pick one.
function readParams(params: string[]): {
  values: Map<string, string>;
  unreadable: boolean;
} {
  const values = new Map<string, string>();
  let unreadable = false;
  let valuelessAt = -1;
  for (const [index, param] of params.entries()) {
    const eq = param.indexOf('=');
    // Keys are lowercase in the grammar; fold case rather than miss an
    // exhausted window over a server sending `R=0`.
    const key = (eq === -1 ? param : param.slice(0, eq)).trim().toLowerCase();
    if (!key) continue;
    if (eq === -1) {
      // A bare `r`/`t` is Boolean true, and parameters are last-wins, so the
      // member's own count or reset is not there to read — `t=3599;t` must not
      // quote 3599 as fact, nor `r=0;t=3599;r` call a window exhausted unasked.
      // Checked before the `continue`, or neither would be caught at all.
      //
      // The two differ in what survives. `r` is REQUIRED, so losing it loses
      // the only thing that says the window is out: nothing to report. `t` is
      // optional, and a member that states `r=0` with no readable reset is an
      // ordinary "exhausted, reset unknown" — already modelled, and already
      // what an unparseable `t=1.5` produces. Dropping the whole member there
      // would throw away a readable `r=0` to avoid an unreadable `t`.
      if (key === 'r') unreadable = true;
      if (key === 't') values.delete('t');
      valuelessAt = index;
      continue;
    }
    // A repeated `r`/`t`, or one that follows a valueless flag: either way
    // we can't say which name the number belongs to.
    if (
      (key === 'r' || key === 't') &&
      (values.has(key) || (valuelessAt !== -1 && index > valuelessAt))
    ) {
      unreadable = true;
    }
    values.set(key, param.slice(eq + 1));
  }
  return { values, unreadable };
}

function parseExhaustedWindows(header: string | null): ParsedWindows {
  if (!header) return { windows: [], dropped: false };
  const windows: ExhaustedWindow[] = [];
  let dropped = false;
  for (const item of splitOutsideStrings(header, ',')) {
    if (item.trim() === '') continue;
    const [rawName, ...params] = splitOutsideStrings(item, ';');
    if (!params.every(isWellFormedParam)) {
      dropped = true;
      continue;
    }
    const { values, unreadable } = readParams(params);
    if (unreadable) {
      dropped = true;
      continue;
    }
    // draft-11 §4.1 makes `r` REQUIRED, so a member without a readable one is
    // malformed: we know a window exists but not whether it is exhausted, which
    // hides at least as much as an item rejected outright. A readable non-zero
    // `r` is different — that window simply has requests left.
    const remaining = remainingRequests(values.get('r'));
    if (remaining === null) {
      dropped = true;
      continue;
    }
    if (remaining !== 0) continue;
    // A name we can't read costs us the name, not the reset behind it.
    windows.push({
      window: windowName(rawName),
      resetS: waitSeconds(values.get('t')),
    });
  }
  return { windows, dropped };
}

// "1724s" is easy to skim past; "~29 minutes" is not, and an agent that grasps
// the scale is the one that stops retrying. Exact seconds stay in the string,
// so the unit is only ever a reading aid — but an agent that skims the unit and
// not the parenthesis must not be sent back early, so each tier rounds UP: 140s
// reads "~3 minutes", never "~2 minutes". The minute and hour tiers hand over
// before their count reaches three digits, a reading as hard to skim as the raw
// seconds it would replace.
function humanWait(seconds: number): string {
  if (seconds < 120) return `~${seconds}s`;
  if (seconds < 3600)
    return `~${Math.ceil(seconds / 60)} minutes (${seconds}s)`;
  if (seconds < 2 * 86400) {
    const hours = Math.ceil(seconds / 3600);
    return `~${hours} hour${hours === 1 ? '' : 's'} (${seconds}s)`;
  }
  // The days tier opens at two days, so it is never singular.
  return `~${Math.ceil(seconds / 86400)} days (${seconds}s)`;
}

// Name the exhausted quota and say how long to wait, from the two headers v2
// sends on a 429 — `Retry-After` (seconds) and `RateLimit` (live per-window
// state, `"minute";r=0;t=12, "hour";r=2800;t=1812`, where r = calls left and
// t = seconds to reset).
//
// Report the LONGEST wait either header justifies. draft-11 §7 says Retry-After
// MUST take precedence, but §6 says a server SHOULD NOT send one earlier than
// the end of the effective window, and this API's is documented "per the
// exceeded window" (tests/fixtures/v2-openapi.yaml) — i.e. it can be earlier.
// RFC 9110 §10.2.3 defines Retry-After as how long a client "ought to wait" and
// sets no upper bound (its "minimum time" wording is scoped to 3xx), so waiting
// longer conforms. §7's "MAY be ignored" is permission, not obligation, and
// max() never waits less than Retry-After asks — so this declines the
// permission rather than violating the precedence. Windows can read r=0
// together — a loop pacing itself at the 60/min quota sits at minute r=0, and
// 3000/hr is an exact multiple of 60, so the call that zeroes the hour is also
// the 60th of its minute — and Retry-After then describes only the window that
// rejected THIS request. Obeying it alone sends the agent back in 12s to a
// quota that is out for another half hour. Hence "wait ~N" rather than "the
// hour quota resets in ~N": the number is an instruction, not a claim about the
// named window, so the two can never contradict each other. Generic guidance
// when neither header is usable — the v1 REST API sends neither, and this
// client also serves the serverless host, which this repo doesn't document.
export function rateLimitHint(
  rateLimitHeader: string | null,
  retryAfterHeader?: string | null
): string {
  const { windows, dropped } = parseExhaustedWindows(rateLimitHeader);
  // Longest reset first; a window that sent no `t` sorts last, since an
  // unknown reset can't outrank a known one. Ties keep header order.
  windows.sort((a, b) => (b.resetS ?? -1) - (a.resetS ?? -1));
  // Typed explicitly: `strict` is on but `noUncheckedIndexedAccess` is not, so
  // `windows[0]` types as non-optional and every `?.` below reads as dead. It
  // isn't — `windows` is empty on every generic-hint path.
  const longestWindow: ExhaustedWindow | undefined = windows[0];
  // A wait of zero — from `t` or from `Retry-After` — is the one instruction a
  // 429 can't mean, so it is not a wait on offer from either source. An
  // HTTP-date Retry-After (legal per RFC 9110, not what this API sends) or
  // junk is likewise rejected, leaving the RateLimit reset to answer.
  const waitCandidates = [
    waitSeconds(retryAfterHeader),
    longestWindow?.resetS,
  ].filter((n): n is number => typeof n === 'number' && n > 0);
  const waitS = waitCandidates.length ? Math.max(...waitCandidates) : null;
  // A Retry-After we couldn't read is a missed instruction, not an absent one:
  // the server named a delay, we don't know it, and it may be far longer than
  // anything RateLimit says. An HTTP-date, `3600.5`, `+1800` and a value past
  // the plausibility cap all land here, hedging the same way they would if the
  // unreadable value had arrived in `t`. A readable `0` is not unreadable.
  const retryAfterUnreadable =
    typeof retryAfterHeader === 'string' &&
    retryAfterHeader.trim() !== '' &&
    waitSeconds(retryAfterHeader) === null;
  // The generic hint is for a response that withheld nothing: no header, no
  // exhausted window, no delay stated. It must not absorb a response that DID
  // state something we failed to read — that would hand back the file's mildest
  // wording precisely when the most was hidden, and a header stating an
  // unreadable day-long lockout would read softer than one stating no reset at
  // all. Anything unread falls through to "no usable reset time" instead.
  if (!longestWindow && waitS === null) {
    if (!retryAfterUnreadable) return GENERIC_RATE_LIMIT_HINT;
  }
  // "the hour quota is exhausted" rather than "rate limited on the hour quota":
  // the response body names the window that rejected THIS request, which in the
  // co-exhaustion case is a different one. Both statements are true, and this
  // phrasing doesn't claim to be the other.
  const namedClause = longestWindow?.window
    ? `the ${longestWindow.window} quota is exhausted`
    : '';
  // Exhausted, but nothing usable said when it clears. A number here would be
  // invented, which is the defect this function exists to avoid.
  if (waitS === null) {
    const cause = namedClause
      ? `${namedClause}, but the response gave no usable reset time`
      : 'the response gave no usable reset time';
    return `rate limited — ${cause}; back off substantially before retrying, and pace bulk operations`;
  }
  // This number is a floor, not the answer, whenever the header held something
  // we couldn't read: another exhausted window that omitted its reset, or an
  // item dropped whole. A quantified 10s window must not speak for a silent
  // day-long one.
  const hedge =
    dropped || retryAfterUnreadable || windows.some((w) => w.resetS === null)
      ? 'at least '
      : '';
  const wait = `wait ${hedge}${humanWait(waitS)} before retrying, and pace bulk operations`;
  return `rate limited — ${namedClause ? `${namedClause}; ` : ''}${wait}`;
}
