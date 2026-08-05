import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rateLimitHint } from '../src/_shared/rate-limit.js';

// A bare "429 - rate limit exceeded" invites an immediate retry — the worst
// response. (Observed live: a bulk GC burned the hourly quota and every delete
// bounced with no guidance.)

describe('429 rate-limit hint', () => {
  const HEADER = '"minute";r=12;t=44, "hour";r=0;t=1724, "day";r=31839;t=23324';

  it('rateLimitHint names the exhausted window and how long to wait', () => {
    assert.equal(
      rateLimitHint(HEADER),
      'rate limited — the hour quota is exhausted; wait ~29 minutes (1724s) before retrying, and pace bulk operations'
    );
  });

  it('rateLimitHint falls back to generic guidance without a header or without an exhausted window', () => {
    assert.match(
      rateLimitHint(null),
      /back off before retrying, and pace bulk operations/
    );
    assert.match(
      rateLimitHint('"minute";r=5;t=10'),
      /back off before retrying, and pace bulk operations/
    );
  });

  // A loop at the 60/min quota sits at minute r=0, and 3000/hr is an exact
  // multiple of 60, so both read r=0 together. Taking the first would promise
  // 12s for a ~30-minute lockout.
  it('rateLimitHint reports the longest-resetting exhausted window, not the first', () => {
    const hint = rateLimitHint(
      '"minute";r=0;t=12, "hour";r=0;t=1812, "day";r=49500;t=45012'
    );
    assert.match(hint, /the hour quota is exhausted/);
    assert.match(hint, /wait ~31 minutes \(1812s\)/);
  });

  // In that state Retry-After describes only the window that rejected THIS
  // request, so the longer of the two wins.
  it('rateLimitHint never promises a shorter wait than the longest exhausted window', () => {
    const hint = rateLimitHint('"minute";r=0;t=12, "hour";r=0;t=1812', '12');
    assert.match(hint, /the hour quota is exhausted/);
    assert.match(hint, /wait ~31 minutes \(1812s\)/);
  });

  it('rateLimitHint takes Retry-After when it is the longer wait', () => {
    assert.match(
      rateLimitHint('"hour";r=0;t=300', '900'),
      /the hour quota is exhausted; wait ~15 minutes \(900s\)/
    );
  });

  it('rateLimitHint uses Retry-After even with no RateLimit header', () => {
    assert.equal(
      rateLimitHint(null, '30'),
      'rate limited — wait ~30s before retrying, and pace bulk operations'
    );
  });

  it('rateLimitHint hedges when Retry-After is present but unreadable', () => {
    // An HTTP-date Retry-After (legal per RFC 9110, not what this API sends)
    // defers to the RateLimit reset — but the date may be further out than
    // that reset, so the number becomes a floor rather than the answer. A past
    // date is harmless; a future one is the reason this hedges.
    for (const retryAfter of [
      'Wed, 21 Oct 2015 07:28:00 GMT',
      'Wed, 21 Oct 2026 07:28:00 GMT',
      '3600.5',
      '+1800',
      '-30',
      String(8 * 86400),
      'soon',
    ]) {
      assert.match(
        rateLimitHint('"hour";r=0;t=1812', retryAfter),
        /wait at least ~31 minutes \(1812s\)/,
        `expected a hedge for Retry-After: ${retryAfter}`
      );
    }
    // "Retry-After: 0" next to a 429 is a contradiction, but it is readable —
    // nothing is unknown, so the window's own reset answers without a hedge.
    assert.match(
      rateLimitHint('"hour";r=0;t=1812', '0'),
      /wait ~31 minutes \(1812s\)/
    );
    // Absent is not unreadable either — and neither is blank. A header that
    // says nothing withheld nothing, so hedging on it would qualify every
    // answer from a server that sends `Retry-After:` with an empty value.
    for (const absent of [null, undefined, '', '   ']) {
      assert.match(
        rateLimitHint('"hour";r=0;t=1812', absent),
        /wait ~31 minutes \(1812s\)/,
        `expected no hedge for Retry-After: ${JSON.stringify(absent)}`
      );
    }
    // With no RateLimit field at all, an unreadable Retry-After is the only
    // thing the response said — the common CDN 429 shape. Answering "back off"
    // and nothing else would hide that a delay was named and then lost.
    assert.match(
      rateLimitHint(null, 'soon'),
      /gave no usable reset time; back off substantially/
    );
  });

  // Params may be reordered, spaced, or unknown without changing meaning. A
  // pattern pinned to `r=<n>;t=<n>` falls back to generic on every one of these.
  it('rateLimitHint tolerates legal structured-field variation', () => {
    for (const header of [
      '"hour"; r=0; t=1724',
      '"hour";t=1724;r=0',
      '"hour";r=0;t=1724;partition_key=abc',
      'hour;r=0;t=1724', // bare token instead of a quoted string
      '"minute";r=5;t=9,"hour";r=0;t=1724',
      // HTAB after `;` isn't legal SF — params allow only SP — but it is
      // trimmed anyway: refusing could only lose a window, never shorten a wait.
      '"hour";\tr=0;\tt=1724',
      '"hour";acme-burst=9;r=0;t=1724', // unknown params are "comments"
      '"hour";r=0;pk=:QXBwLTk5OQ==:;t=1724', // interleaved byte-sequence param
      '"hour";R=0;T=1724', // uppercase keys: invalid, but don't miss it
      '"hour";r=0;t=1724, "day";acme-x=1;r=0;t=9', // vendor param, shorter
    ]) {
      assert.match(
        rateLimitHint(header),
        /the hour quota is exhausted; wait ~29 minutes \(1724s\)/,
        `failed on: ${header}`
      );
    }
  });

  // `t` is optional, so "exhausted, reset unknown" is legal. Name the window;
  // a default here would repeat the reporting-the-shortest-window defect.
  it('rateLimitHint reports an exhausted window that omitted its reset', () => {
    const hint = rateLimitHint('"day";r=0');
    assert.match(hint, /the day quota is exhausted/);
    assert.match(hint, /gave no usable reset time; back off substantially/);
    assert.doesNotMatch(hint, /\d+s\)/);
    assert.doesNotMatch(hint, /wait ~/);
    // Retry-After fills the gap when it is present — but the wait is a floor,
    // not the answer, while a window's own reset is still unknown.
    assert.match(rateLimitHint('"day";r=0', '90'), /wait at least ~90s/);
  });

  // A quoted string can't be a parameter key, so two items run together with
  // no comma is a malformed field, not a second item. Guessing which name owns
  // the trailing `r` is how a window with 2800 calls left gets reported as
  // exhausted; the draft says to ignore a malformed field instead.
  it('rateLimitHint ignores items run together without a comma', () => {
    for (const header of [
      '"hour";r=2800;t=1812;"minute";r=0;t=12',
      '"hour";r=0;t=1812;"minute";r=0;t=12',
      '"hour";r=0;t=9\n"minute";r=0;t=1', // a line break can't appear in a value
    ]) {
      assert.match(
        rateLimitHint(header),
        /back off before retrying, and pace bulk operations/,
        `failed on: ${header}`
      );
    }
  });

  // A dropped comma glues the next item onto the previous parameter's VALUE
  // (`t=3600 "minute"`), which last-wins then merges into one item under the
  // FIRST name and the SECOND reset — a 3600s lockout answered with "wait 10s",
  // or a window with requests left reported as exhausted.
  it('rateLimitHint ignores items glued together by a dropped comma', () => {
    for (const header of [
      '"hour";r=0;t=3600 "minute";r=0;t=10',
      '"minute";r=0;t=10 "hour";r=0;t=3600',
      '"minute";r=5;t=10 "hour";r=0;t=3600', // first window is NOT exhausted
      '"hour";r=0;t=3600"minute";r=0;t=10', // no space at all
      'hour;r=0;t=3600 minute;r=0;t=10', // token form, no quotes anywhere
    ]) {
      assert.match(
        rateLimitHint(header),
        /back off before retrying, and pace bulk operations/,
        `failed on: ${header}`
      );
    }
  });

  // An item dropped whole hides MORE than one that merely omitted its `t`, so
  // a readable 10-second sibling must not answer as if it were the whole truth.
  it('rateLimitHint qualifies the wait when an item was dropped unread', () => {
    for (const header of [
      '"minute";r=0;t=10, "hour";"x"=1;r=0;t=3600', // malformed parameters
      '"minute";r=0;t=10, "hour";t=3600', // `r` is REQUIRED, so this is too
      '"minute";r=0;t=10, "hour";r=;t=3600', // blank `r`
      '"minute";r=0;t=10, "hour";r;t=3600', // valueless `r`
    ]) {
      assert.match(
        rateLimitHint(header),
        /wait at least ~10s/,
        `failed on: ${header}`
      );
    }
    // A readable non-zero `r` is not hidden information — that window simply
    // has requests left, and the wait stays unqualified.
    assert.match(
      rateLimitHint('"minute";r=0;t=10, "hour";r=2800;t=3600'),
      /the minute quota is exhausted; wait ~10s/
    );
    // Same when the whole field was rejected and only Retry-After survived.
    assert.match(
      rateLimitHint('"minute";r=0;t=10\r\n "hour";r=0;t=3600', '10'),
      /wait at least ~10s/
    );
  });

  // `Headers.get()` joins repeated fields with ", ", and a trailing comma is
  // legal in a structured field. An empty item hides nothing, so it must not
  // make the wait read as a floor.
  it('rateLimitHint does not treat an empty item as hidden information', () => {
    for (const header of [
      '"hour";r=0;t=60,',
      ',"hour";r=0;t=60',
      '"hour";r=0;t=60,,',
    ]) {
      assert.match(
        rateLimitHint(header),
        /the hour quota is exhausted; wait ~60s before/,
        `failed on: ${header}`
      );
    }
  });

  // A value that opens a quote and never closes it swallows the rest of the
  // item, so that window's r/t are gone — the hint must not let a readable
  // sibling answer as though nothing were missing.
  it('rateLimitHint qualifies the wait when a quote is never closed', () => {
    assert.match(
      rateLimitHint('"minute";r=0;t=10, "hour";pk="abc;r=0;t=3600'),
      /wait at least ~10s/
    );
  });

  // Anything a quoted string may legally hold is a name we can print — a policy
  // called `"gpu hour"` should be named, not silently dropped.
  it('rateLimitHint accepts a quoted name containing spaces or delimiters', () => {
    assert.match(
      rateLimitHint('"gpu hour";r=0;t=3600'),
      /the gpu hour quota is exhausted/
    );
    assert.match(
      rateLimitHint('"10/hour";r=0;t=3600'),
      /the 10\/hour quota is exhausted/
    );
    // Dropping a legal name would discard its reset too, letting a shorter
    // sibling answer unqualified — the under-report this all exists to stop.
    assert.match(
      rateLimitHint('"a,b";r=0;t=3600'),
      /the a,b quota is exhausted/
    );
    assert.match(
      rateLimitHint('"a,b";r=0;t=3600, "minute";r=0;t=10'),
      /the a,b quota is exhausted; wait ~1 hour \(3600s\)/
    );
  });

  // A bare name follows the token grammar: it starts with a letter or `*` and
  // may hold any tchar. A leading digit is an integer, not a name.
  it('rateLimitHint accepts a bare name only where the token grammar allows', () => {
    assert.match(
      rateLimitHint('per-user!;r=0;t=3600'),
      /the per-user! quota is exhausted/
    );
    assert.match(rateLimitHint('*;r=0;t=60'), /the \* quota is exhausted/);
    // A leading digit or `_` is not a token: the name is dropped, not printed.
    for (const header of ['_burst;r=0;t=60', '5;r=0;t=60']) {
      assert.match(
        rateLimitHint(header),
        /^rate limited — wait ~60s/,
        `failed on: ${header}`
      );
    }
  });

  // A delimiter inside a quoted parameter value is legal and must not cut the
  // item in half — losing that window's r/t while a shorter one survives is how
  // a 30-minute lockout gets answered with "wait 12s".
  it('rateLimitHint does not split on a delimiter inside a quoted value', () => {
    for (const header of [
      '"minute";r=0;t=12, "hour";pk="a,b";r=0;t=1812',
      '"minute";r=0;t=12, "hour";pk="p;";r=0;t=1812',
    ]) {
      assert.match(
        rateLimitHint(header),
        /the hour quota is exhausted; wait ~31 minutes \(1812s\)/,
        `failed on: ${header}`
      );
    }
  });

  // Testing only the first and last character of a quoted value would pass
  // `pk="x" "minute"` — a second item glued on after a legal value, which
  // last-wins then merges into the first item's name and the second's reset.
  it('rateLimitHint ignores an item glued on after a quoted value', () => {
    assert.match(
      rateLimitHint('"hour";r=0;t=1812;pk="x" "minute";r=0;t=10'),
      /back off before retrying, and pace bulk operations/
    );
    // The same glue without a repeated `r`/`t` to give it away: only the
    // full-match check stands between this and a confident "wait ~10s" for a
    // window whose own reset the header never states.
    assert.match(
      rateLimitHint('"hour";r=0;pk="x" "minute";t=10'),
      /back off before retrying, and pace bulk operations/
    );
    // The legal form still parses.
    assert.match(
      rateLimitHint('"hour";r=0;t=1812;pk="x"'),
      /the hour quota is exhausted; wait ~31 minutes \(1812s\)/
    );
  });

  // A `\"` inside a string doesn't close it, so the `;` after it is still
  // inside the value and must not cut the item's params off.
  it('rateLimitHint honours escaped quotes inside a parameter value', () => {
    assert.match(
      rateLimitHint('"hour";pk="a\\";b";r=0;t=1812'),
      /the hour quota is exhausted; wait ~31 minutes \(1812s\)/
    );
  });

  // A flag with no number after it can't have stolen one, so the item is kept.
  it('rateLimitHint keeps an item whose only flag trails its numbers', () => {
    assert.match(
      rateLimitHint('"hour";r=0;t=3600;acme-flag'),
      /the hour quota is exhausted; wait ~1 hour \(3600s\)/
    );
    // But a number after the flag could belong to either name.
    assert.match(
      rateLimitHint('"minute";t=10;hour;r=0'),
      /back off before retrying, and pace bulk operations/
    );
  });

  // The grammar says a repeated parameter is last-wins, but a member carrying
  // `r` or `t` twice is far likelier to be two items glued by a dropped comma —
  // and then last-wins answers a 2876s lockout with 1641s. We can't tell which
  // value belongs to the name, so the wait is hedged rather than guessed.
  it('rateLimitHint does not pick a winner between repeated r or t', () => {
    for (const header of [
      '"hour";r=5;r=0;t=1724',
      'minute;r=0;t=2876;minute;r=0;t=1641',
      '"hour";r=2800;t=1812;minute;r=0;t=12',
    ]) {
      assert.match(
        rateLimitHint(header),
        /back off before retrying, and pace bulk operations/,
        `failed on: ${header}`
      );
    }
    // A sibling that IS readable still answers, qualified.
    assert.match(
      rateLimitHint('"minute";r=0;t=10, "hour";r=5;r=0;t=1724'),
      /the minute quota is exhausted; wait at least ~10s/
    );
    // Only `r` and `t` carry that signal — a repeated vendor parameter says
    // nothing about which window the numbers belong to.
    assert.match(
      rateLimitHint('"hour";acme-x=1;acme-x=2;r=0;t=1724'),
      /the hour quota is exhausted; wait ~29 minutes \(1724s\)/
    );
  });

  // A repeat whose second occurrence is VALUELESS is the same loss: parameters
  // are last-wins and a bare flag is Boolean true, so `t=3599;t` has no
  // readable reset and `r=0;r` never says the window is out. Quoting 3599 as
  // fact, or calling that window exhausted, both invent an answer.
  it('rateLimitHint treats a bare r or t as an unreadable value', () => {
    // A bare `t` costs only the reset. `r=0` still says the window is out, and
    // "exhausted, reset unknown" is a state the hint already has words for —
    // dropping the member would discard a readable `r=0` over an unreadable
    // `t`, and would read SOFTER than a member that stated no reset at all.
    for (const header of ['"hour";r=0;t', '"hour";r=0;t=3599;t']) {
      const hint = rateLimitHint(header);
      assert.match(
        hint,
        /the hour quota is exhausted, but the response gave no usable reset time/,
        `failed on: ${header}`
      );
      // Never the value the bare flag overwrote.
      assert.doesNotMatch(hint, /3599/, `failed on: ${header}`);
    }
    // A bare `r` costs the REQUIRED parameter: nothing is left to say the
    // window is out, so there is no member to report.
    for (const header of [
      '"hour";r=0;t=3599;r',
      '"hour";t;r=0;t=3599', // flag before the numbers: which name owns them?
      'req-per-sec;r=00;r;x=:AA==:',
    ]) {
      assert.match(
        rateLimitHint(header),
        /back off before retrying, and pace bulk operations$/,
        `failed on: ${header}`
      );
    }
    // A readable sibling still answers, qualified — and must not borrow the
    // 3599 that the dropped member failed to establish.
    const hint = rateLimitHint('"hour";r=0;t=3599;t, "minute";r=0;t=10');
    assert.match(hint, /the minute quota is exhausted; wait at least ~10s/);
    assert.doesNotMatch(hint, /3599/);
    // A bare VENDOR flag carries no such signal: only `r`/`t` can be made
    // unreadable by a repeat. Trailing it keeps this distinct from the
    // flag-before-numbers shape above, which drops for a different reason.
    assert.match(
      rateLimitHint('"hour";r=0;t=1724;acme-beta'),
      /the hour quota is exhausted; wait ~29 minutes \(1724s\)/
    );
  });

  // A name we can't read in full is a name we shouldn't print. Sanitizing
  // instead of rejecting turns `"a,b"` into a confident "the b quota".
  it('rateLimitHint omits a name it could not read, keeping the reset', () => {
    for (const header of [
      '"hôur";r=0;t=3600', // non-ASCII, not a legal sf-string
      'junk "hour";r=0;t=3600', // not a name in any grammar
      '"gpu \\"burst\\"";r=0;t=3600', // legal, but escapes are unsupported
    ]) {
      const hint = rateLimitHint(header);
      assert.match(
        hint,
        /^rate limited — wait ~1 hour \(3600s\)/,
        `failed on: ${header}`
      );
      assert.doesNotMatch(hint, /quota is exhausted/, `failed on: ${header}`);
    }
    // Nothing readable at all still falls back.
    assert.match(
      rateLimitHint('limit=100, remaining=0, reset=50'), // an older draft's form
      /back off before retrying, and pace bulk operations/
    );
  });

  // Integers cap at 15 digits; `Number()` would turn 20 of them into 1e20.
  it('rateLimitHint rejects out-of-range and non-integer quota values', () => {
    for (const header of [
      '"hour";r=0;t=99999999999999999999', // 20 digits
      '"hour";r=0;t=1.5', // Decimal, not Integer
      '"hour";r=0;t=-30', // negative
      '"hour";r=0;t=0x10', // not decimal
      '"hour";r=0;t=1e3', // not decimal
    ]) {
      const hint = rateLimitHint(header);
      assert.match(hint, /the hour quota is exhausted/, `failed on: ${header}`);
      assert.doesNotMatch(hint, /wait ~/, `failed on: ${header}`);
    }
    // Same guard on Retry-After — but the two are not symmetric. An unreadable
    // `t` leaves that window with no reset at all; an unreadable Retry-After
    // means the server named a delay we can't read, which may exceed every
    // window, so the surviving number is only a floor.
    assert.match(
      rateLimitHint('"hour";r=0;t=300', '99999999999999999999'),
      /wait at least ~5 minutes \(300s\)/
    );
  });

  // The name lands verbatim in an MCP error payload; nothing bounds it.
  // Truncating would print a name that isn't in the header — the same defect as
  // sanitizing one. 32 chars in, 33 out.
  it('rateLimitHint prints a name up to 32 characters and no further', () => {
    assert.match(
      rateLimitHint(`"${'x'.repeat(32)}";r=0;t=60`),
      /the x{32} quota is exhausted; wait ~60s/
    );
    // Truncating would print a name that isn't in the header; the reset beside
    // it is still trustworthy, so only the name is dropped.
    const tooLong = rateLimitHint(`"${'x'.repeat(33)}";r=0;t=60`);
    assert.doesNotMatch(tooLong, /x/);
    assert.match(tooLong, /^rate limited — wait ~60s/);
  });

  // No window this API reports is longer than a day, so a wait past a week is
  // a broken header. Printing "~27777777778 hours" is worse than saying the
  // reset is unknown — and a digit-count limit alone wouldn't catch it.
  it('rateLimitHint rejects an implausibly distant reset', () => {
    const hint = rateLimitHint('"hour";r=0;t=100000000000000');
    assert.match(hint, /the hour quota is exhausted/);
    assert.match(hint, /gave no usable reset time/);
    // Nothing readable survives, but the server DID state a delay, so the
    // response withheld something the generic hint would not admit to.
    assert.equal(
      rateLimitHint(null, '100000000000000'),
      'rate limited — the response gave no usable reset time; back off substantially before retrying, and pace bulk operations'
    );
    // A week still parses; a week and a second does not.
    assert.match(
      rateLimitHint('"day";r=0;t=604800'),
      /wait ~7 days \(604800s\)/
    );
    assert.match(
      rateLimitHint('"day";r=0;t=604801'),
      /gave no usable reset time/
    );
  });

  // Never throw on junk, and never let one malformed member hide a readable one.
  it('rateLimitHint degrades to generic guidance on malformed input', () => {
    for (const header of [
      '',
      ',,,',
      '"hour"',
      '"hour";r=abc;t=xyz',
      '"hour";r=;t=',
      ';;;=',
      '"hour";r=1;t=5', // parseable, nothing exhausted
    ]) {
      assert.match(
        rateLimitHint(header),
        /back off before retrying, and pace bulk operations/,
        `failed on: ${header}`
      );
    }
    assert.match(
      rateLimitHint('garbage, "hour";r=0;t=1724'),
      /the hour quota is exhausted/
    );
  });

  // "wait ~0s" and "wait ~1s" are the same instruction to an agent, and a 429
  // can't mean "retry now" — so a zero reset is treated as no reset at all,
  // whichever header it came from.
  it('rateLimitHint treats a zero reset as no reset', () => {
    assert.match(
      rateLimitHint('"minute";r=0;t=0'),
      /gave no usable reset time/
    );
    assert.match(
      rateLimitHint('"minute";r=0;t=0, "day";r=0'),
      /gave no usable reset time/
    );
  });

  // "Retry-After: 0" is the one instruction a 429 can't mean. With no window
  // reset to fall back on, say nothing specific rather than "wait ~1s".
  it('rateLimitHint does not turn Retry-After: 0 into a 1s wait', () => {
    assert.match(
      rateLimitHint(null, '0'),
      /back off before retrying, and pace bulk operations/
    );
    assert.match(
      rateLimitHint('"hour";r=5;t=9', '0'),
      /back off before retrying, and pace bulk operations/
    );
  });

  // A name may start with a digit (`5m`, `1h`) — rejecting those would quietly
  // stop naming the window if the API ever renames its quotas.
  it('rateLimitHint accepts a window name starting with a digit', () => {
    assert.match(rateLimitHint('"5m";r=0;t=300'), /the 5m quota is exhausted/);
    assert.match(rateLimitHint('"1h";r=0;t=1812'), /the 1h quota is exhausted/);
  });

  // `;r` with no `=` is a legal boolean parameter, not "r is zero".
  it('rateLimitHint does not read a valueless r as exhausted', () => {
    assert.match(
      rateLimitHint('"hour";r;t=1812'),
      /back off before retrying, and pace bulk operations/
    );
  });

  // Unit boundaries: seconds below 2 minutes, hours from 2 hours up.
  // The unit an agent skims must never sit below the exact wait: 140s reading
  // as "~2 minutes" (120s) is this module's own defect in miniature. Round up.
  it('rateLimitHint never renders a unit shorter than the exact wait', () => {
    for (const [t, unit] of [
      [140, /~3 minutes \(140s\)/],
      [1812, /~31 minutes \(1812s\)/],
      [44000, /~13 hours \(44000s\)/],
      [200000, /~3 days \(200000s\)/],
    ] as [number, RegExp][]) {
      assert.match(
        rateLimitHint(`"hour";r=0;t=${t}`),
        unit,
        `failed on t=${t}`
      );
    }
  });

  // A display string is a legal parameter value. Reading it as malformed would
  // collapse every hint to generic the day the API adds one.
  it('rateLimitHint accepts a display-string parameter value', () => {
    assert.match(
      rateLimitHint('"hour";r=0;t=60;acme-x=%"caf%c3%a9"'),
      /the hour quota is exhausted; wait ~60s/
    );
    // Inside a display string a backslash is a literal, not an escape — read
    // as an escape it eats the closing quote and swallows the rest of the field.
    assert.match(
      rateLimitHint('"hour";r=0;t=3600;acme-x=%"a\\", "minute";r=0;t=10'),
      /the hour quota is exhausted; wait ~1 hour \(3600s\)/
    );
    // Still whole-matched, so glue after one is still caught.
    assert.match(
      rateLimitHint('"hour";r=0;acme-x=%"a" "minute";t=10'),
      /back off before retrying, and pace bulk operations/
    );
  });

  // "1724s" is easy to skim past; half an hour is not. But never print a
  // three-digit minute or hour count either — those are exactly as hard to skim
  // as the raw seconds the unit exists to replace. Every tier and both sides of
  // every edge, in one table: the seconds are always shown, so no rounding can
  // hide the real number, and rounding is UP throughout — one second past an
  // edge must not round back down to the tier it just left.
  it('rateLimitHint scales the unit to the wait', () => {
    const expected: [number, RegExp][] = [
      [44, /wait ~44s before/],
      [119, /wait ~119s before/],
      [120, /wait ~2 minutes \(120s\) before/],
      [3599, /wait ~60 minutes \(3599s\) before/],
      [3600, /wait ~1 hour \(3600s\) before/],
      [3601, /wait ~2 hours \(3601s\) before/],
      [45012, /wait ~13 hours \(45012s\) before/],
      [172799, /wait ~48 hours \(172799s\) before/],
      [172800, /wait ~2 days \(172800s\) before/],
      [172801, /wait ~3 days \(172801s\) before/],
    ];
    for (const [seconds, pattern] of expected) {
      assert.match(
        rateLimitHint(`"hour";r=0;t=${seconds}`),
        pattern,
        `failed at t=${seconds}`
      );
    }
  });

  // Equal resets: keep the order the header gave them.
  it('rateLimitHint keeps header order when two windows tie', () => {
    assert.match(
      rateLimitHint('"minute";r=0;t=60, "hour";r=0;t=60'),
      /the minute quota is exhausted/
    );
  });

  it('rateLimitHint rejects a carriage return as well as a newline', () => {
    for (const header of [
      '"hour";r=0;t=9\r"minute";r=0;t=1',
      '"hour";r=0;t=9\r\n"minute";r=0;t=1',
    ]) {
      assert.match(
        rateLimitHint(header),
        /back off before retrying, and pace bulk operations/,
        `failed on: ${JSON.stringify(header)}`
      );
    }
  });

  it('rateLimitHint names the longest window when all three are exhausted', () => {
    assert.match(
      rateLimitHint('"minute";r=0;t=12, "hour";r=0;t=1812, "day";r=0;t=45012'),
      /the day quota is exhausted; wait ~13 hours \(45012s\)/
    );
  });
});

// ── the property the whole module exists to hold ─────────────────────────────
// Every fix in this file's history was one shape of the same bug: a wait
// shorter than the truth, presented as the answer. State it once as a property
// and generate the shapes, so the next shape fails here rather than in a 429.
describe('429 rate-limit hint — never under-reports unhedged', () => {
  // A deliberately naive reader of the header: every `r=0` member's `t`,
  // however the member is punctuated. It over-reads where the parser refuses
  // to guess, which is the point — if the hint quotes a number at all, it must
  // not be below what this finds, unless it says "at least".
  // Retry-After is half the selection rule, so the property has to drive it:
  // without this, `Math.max` over the two sources could be `Math.min` and no
  // generated case would notice.
  function plainDelaySeconds(retryAfter: string | null): number {
    return retryAfter && /^\d{1,7}$/.test(retryAfter) ? Number(retryAfter) : 0;
  }

  function longestExhaustedReset(header: string): number {
    let longest = 0;
    for (const [, t] of header.matchAll(/r=0\s*;\s*t=(\d{1,7})\b/g)) {
      longest = Math.max(longest, Number(t));
    }
    for (const [, t] of header.matchAll(/t=(\d{1,7})\s*;\s*r=0\b/g)) {
      longest = Math.max(longest, Number(t));
    }
    return longest;
  }

  // Whether any member hides a lockout the hint cannot see, so that answering
  // with a bare number would overstate what the header established. Two ways:
  // an exhausted member with no readable reset, and — the case `dropped` exists
  // for — a member showing a reset but no readable `r`, which may be at zero
  // for all we know. Without the second clause the whole `dropped` guard is
  // invisible to this property.
  function hidesALockout(header: string): boolean {
    return header.split(',').some((member) => {
      const exhaustedWithNoReset =
        /\br=0\b/.test(member) && !/\bt=\d/.test(member);
      const resetWithNoReadableRemaining =
        /\bt=\d/.test(member) && !/\br=\d/.test(member);
      return exhaustedWithNoReset || resetWithNoReadableRemaining;
    });
  }

  // The exact seconds are always in the message: "~44s", "~1 hour (3600s)",
  // "~29 minutes (1724s)". Singular units matter — under ceil rounding
  // `~1 hour` is exactly 3600s, and the oracle must still be able to read it.
  const WAIT_RE =
    /wait (at least )?~(?:\d+ (?:minute|hour|day)s? \((\d+)s\)|(\d+)s)/;
  function quotedWait(hint: string): {
    seconds: number | null;
    hedged: boolean;
  } {
    const m = WAIT_RE.exec(hint);
    // An extractor that silently fails to parse turns this whole suite into a
    // no-op, so treat a wait we can't read as a failure of the test, not a pass.
    assert.ok(
      m || !/wait /.test(hint),
      `oracle could not read the wait out of: ${hint}`
    );
    if (!m) return { seconds: null, hedged: false };
    return { seconds: Number(m[2] ?? m[3]), hedged: Boolean(m[1]) };
  }

  it('holds across generated headers, including mangled ones', () => {
    // Deterministic, and exact mod 2^32 — a plain `seed * 1103515245` exceeds
    // Number.MAX_SAFE_INTEGER and collapses the stream to ~1k distinct values.
    let seed = 20260730;
    const rnd = () =>
      (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];

    const names = [
      '"minute"',
      '"hour"',
      '"day"',
      'minute',
      '"gpu hour"',
      '"a,b"',
    ];
    // Separators: legal, then every way a comma goes missing.
    const glue = [', ', ',', ' ', ';', '', ';;', ',,'];
    // Parameters the draft leaves open, including ones carrying a delimiter.
    const extras = [
      '',
      ';pk=:QXBwLTk5OQ==:',
      ';acme-x=1',
      ';pk="a,b"',
      ';flag',
    ];
    const seen = new Set<string>();
    const failures: string[] = [];

    for (let i = 0; i < 20000; i++) {
      const members: string[] = [];
      for (let j = 0; j < 1 + Math.floor(rnd() * 3); j++) {
        const parts = [pick(names)];
        // `r` and `t` are each sometimes absent: `t` is optional in the
        // grammar and `r` missing is malformed, and both must reach the hedge.
        // `r` is also sometimes present but unreadable, which is a different
        // case from absent and the one the `dropped` guard exists for — a
        // member that shows a reset while never establishing it is at zero.
        if (rnd() > 0.1)
          parts.push(
            rnd() < 0.15
              ? `r=${pick(['abc', '', '-1', '1.5', '0x10', '1e3'])}`
              : `r=${rnd() < 0.6 ? 0 : Math.floor(rnd() * 3000)}`
          );
        if (rnd() > 0.2) parts.push(`t=${Math.floor(rnd() * 5000)}`);
        members.push(parts.join(';') + pick(extras));
      }
      const header = members.join(pick(glue));
      seen.add(header);
      // Sometimes absent, sometimes junk, sometimes a delay that straddles the
      // windows' own resets in either direction.
      const retryAfter = pick([
        null,
        null,
        'soon',
        '0',
        '3600.5',
        'Wed, 21 Oct 2026 07:28:00 GMT',
        String(8 * 86400),
        String(Math.floor(rnd() * 5000)),
      ]);
      const hint = rateLimitHint(header, retryAfter);
      const { seconds, hedged } = quotedWait(hint);
      const truth = Math.max(
        longestExhaustedReset(header),
        plainDelaySeconds(retryAfter)
      );
      if (seconds !== null && !hedged && seconds < truth) {
        failures.push(
          `${header}\n    quoted ${seconds}s, header shows ${truth}s`
        );
      }
      // The other half of the property: a member that hides a lockout — no
      // readable reset, or no readable `r` to say it isn't exhausted — must
      // not be answered with a bare number.
      if (seconds !== null && !hedged && hidesALockout(header)) {
        failures.push(
          `${header}\n    quoted ${seconds}s unhedged, but a member hides a lockout`
        );
      }
      // Same rule for the other header. `plainDelaySeconds` scores an
      // unreadable Retry-After as 0, so the check above can never catch this —
      // a server that named a delay we can't parse may have meant far longer
      // than anything RateLimit says, and the number stays a floor.
      if (
        seconds !== null &&
        !hedged &&
        retryAfter !== null &&
        plainDelaySeconds(retryAfter) === 0 &&
        retryAfter !== '0'
      ) {
        failures.push(
          `${header}\n    quoted ${seconds}s unhedged against unreadable Retry-After: ${retryAfter}`
        );
      }
    }
    assert.deepEqual(
      failures.slice(0, 3),
      [],
      `${failures.length} under-reports`
    );
    // A generator that degenerates tests one input 20000 times.
    assert.ok(
      seen.size > 15000,
      `only ${seen.size} distinct headers generated`
    );
  });
});
