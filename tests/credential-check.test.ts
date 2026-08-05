import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';

import { createCredentialChecker } from '../src/_shared/credential-check.js';
import {
  buildToolContext,
  defaultCredentialChecker,
  handleMcpRequest,
  bodyIsCheckable,
} from '../src/http.js';

// ============== Credential pre-flight (hosted 401 re-auth) ==============
// A dead bearer (expired/revoked OAuth-minted key) must produce a real HTTP
// 401 + WWW-Authenticate from the hosted server — that response is what makes
// OAuth-capable MCP clients re-run their auth flow. These tests pin the
// checker's verdict logic (observed live backend behavior), its cache, its
// fail-open posture, and the handleMcpRequest wiring end to end.

interface FetchCall {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  };
}

function checkerHarness(opts: {
  status?: number;
  jsonBody?: unknown;
  reject?: boolean;
  now?: () => number;
  validTtlMs?: number;
  invalidTtlMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
  // Resolve the fetch only when the returned trigger is called, so a test can
  // hold several checks in flight at once.
  gate?: { wait: Promise<void> };
  // Never settle on its own — only when the abort signal fires. This is what
  // makes the timeout observable; a fetch that throws immediately proves nothing.
  hang?: boolean;
}) {
  const calls: FetchCall[] = [];
  const handle = createCredentialChecker({
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (opts.hang) {
        return new Promise((_resolve, reject) => {
          // AbortSignal.timeout()'s internal timer is unref'd, so with nothing
          // else keeping the event loop alive the loop drains BEFORE the abort
          // fires and node:test cancels the whole file ("Promise resolution is
          // still pending but the event loop has already resolved") — the CI
          // failure mode on every Node version. Hold a ref'd timer for slightly
          // longer than any timeout under test so the abort can actually fire;
          // clear it the moment it does.
          const keepAlive = setTimeout(
            () => {},
            (opts.timeoutMs ?? 4000) + 1000
          );
          init.signal?.addEventListener('abort', () => {
            clearTimeout(keepAlive);
            reject(new Error('aborted'));
          });
        });
      }
      if (opts.gate) await opts.gate.wait;
      if (opts.reject) throw new Error('network down');
      const status = opts.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => opts.jsonBody ?? {},
      };
    },
    url: () => 'https://graphql.test/graphql',
    now: opts.now,
    validTtlMs: opts.validTtlMs,
    invalidTtlMs: opts.invalidTtlMs,
    timeoutMs: opts.timeoutMs,
    maxEntries: opts.maxEntries,
  });
  return { check: handle.verify, invalidate: handle.invalidate, calls };
}

describe('createCredentialChecker — verdicts (pins observed backend behavior)', () => {
  it('valid key: 200 with myself.id → valid; sends the bearer to the auth URL', async () => {
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'user-1' } } },
    });
    const verdict = await check('rpa_live');
    assert.equal(verdict.status, 'valid');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://graphql.test/graphql');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer rpa_live');
    assert.match(calls[0].init.body, /myself \{ id \}/);
  });

  it('expired/revoked key: HTTP 401 → invalid with an actionable reason', async () => {
    const { check } = checkerHarness({ status: 401 });
    const verdict = await check('rpa_dead');
    assert.equal(verdict.status, 'invalid');
    assert.match((verdict as { reason: string }).reason, /revoked/);
  });

  it('anonymous token: 200 with myself:null → invalid (no identity)', async () => {
    const { check } = checkerHarness({ jsonBody: { data: { myself: null } } });
    const verdict = await check('garbage');
    assert.equal(verdict.status, 'invalid');
    assert.match((verdict as { reason: string }).reason, /does not resolve/);
  });

  it('FAILS OPEN on 200 + myself:null WITH errors (a resolver blip is not a dead credential)', async () => {
    // GraphQL returns HTTP 200 with `myself: null` AND an `errors` array when the
    // resolver itself fails — the null is a server fault, not a dead token. The
    // shape is identical for every caller during a backend blip, so classifying
    // it `invalid` would 401 every VALID key at once and drive every OAuth client
    // into the key-minting re-auth loop. Must fail open, like the 403 case.
    const { check } = checkerHarness({
      jsonBody: {
        data: { myself: null },
        errors: [{ message: 'internal error' }],
      },
    });
    assert.equal(
      (await check('rpa_good_but_backend_blipped')).status,
      'unknown'
    );
  });

  it('FAILS OPEN on any errors array, even alongside a bare data:null', async () => {
    const { check } = checkerHarness({
      jsonBody: { data: null, errors: [{ message: 'boom' }] },
    });
    assert.equal((await check('rpa_x')).status, 'unknown');
  });

  it('FAILS OPEN on 5xx and on network errors (an auth-backend blip must not take the server down)', async () => {
    const fiveHundred = checkerHarness({ status: 503 });
    assert.equal((await fiveHundred.check('rpa_x')).status, 'unknown');

    const netdown = checkerHarness({ reject: true });
    assert.equal((await netdown.check('rpa_x')).status, 'unknown');
  });

  it('FAILS OPEN on an unrecognized response shape', async () => {
    const { check } = checkerHarness({ jsonBody: { weird: true } });
    assert.equal((await check('rpa_x')).status, 'unknown');
  });

  it('FAILS OPEN on 403 — a WAF block is not a dead credential', async () => {
    // This host is behind Cloudflare, so a bot/WAF block answers 403 with no
    // relation to the token; a permission-scoped key can 403 while still
    // working elsewhere. Hard-failing here sent a 401, the client re-ran OAuth,
    // and OAuth MINTS A NEW API KEY — a loop that never recovers and fills the
    // user's dashboard with keys.
    const { check } = checkerHarness({ status: 403 });
    assert.equal((await check('rpa_scoped')).status, 'unknown');
  });

  it(
    'a backend that never responds is abandoned by the timeout, and fails open',
    { timeout: 5000 },
    async () => {
      // Fail-open covers an ERRORING backend; this covers a HANGING one. Without a
      // working timeout the pre-flight holds the MCP request until the platform
      // limit turns it into a 504 for every caller. The fake here settles only when
      // the abort fires, so this test cannot pass unless the timeout really works —
      // the previous pair asserted a signal object existed and threw immediately,
      // and both still passed with the timeout replaced by a signal that never fires.
      const { check, calls } = checkerHarness({ hang: true, timeoutMs: 25 });
      const started = Date.now();
      const verdict = await check('rpa_x');
      assert.equal(
        verdict.status,
        'unknown',
        'a timed-out check must fail open'
      );
      assert.ok(
        Date.now() - started < 2000,
        'the check was not abandoned promptly'
      );
      assert.ok(calls[0].init.signal, 'no AbortSignal was passed to fetch');
    }
  );

  it(
    'a timed-out verdict is not cached (it is a guess, not an answer)',
    { timeout: 5000 },
    async () => {
      const { check, calls } = checkerHarness({ hang: true, timeoutMs: 15 });
      await check('rpa_x');
      await check('rpa_x');
      assert.equal(calls.length, 2);
    }
  );
});

describe('createCredentialChecker — cache', () => {
  it('caches a valid verdict (one upstream call for repeated checks)', async () => {
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
    });
    await check('rpa_live');
    await check('rpa_live');
    await check('rpa_live');
    assert.equal(calls.length, 1);
  });

  it('caches per token — different tokens verify independently', async () => {
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
    });
    await check('rpa_a');
    await check('rpa_b');
    assert.equal(calls.length, 2);
  });

  it('an invalid verdict expires quickly so a re-authorized user is not locked out', async () => {
    let t = 0;
    const { check, calls } = checkerHarness({
      status: 401,
      now: () => t,
      invalidTtlMs: 1000,
    });
    assert.equal((await check('rpa_dead')).status, 'invalid');
    t = 500; // still cached
    assert.equal((await check('rpa_dead')).status, 'invalid');
    assert.equal(calls.length, 1);
    t = 1500; // past the invalid TTL → re-verify upstream
    await check('rpa_dead');
    assert.equal(calls.length, 2);
  });

  it('a valid verdict re-verifies after its TTL (revocation is noticed)', async () => {
    let t = 0;
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      now: () => t,
      validTtlMs: 10_000,
    });
    await check('rpa_live');
    t = 9_999;
    await check('rpa_live');
    assert.equal(calls.length, 1);
    t = 10_001;
    await check('rpa_live');
    assert.equal(calls.length, 2);
  });

  it('does NOT cache a fail-open verdict (a guess must not outlive the blip)', async () => {
    // Caching an indeterminate "assume valid" for a full valid-TTL means one
    // auth-backend hiccup lets a genuinely dead credential skip the 401 re-auth
    // signal for that whole window — the bug this module exists to fix.
    for (const opts of [
      { status: 503 },
      { reject: true },
      { jsonBody: { weird: true } },
      { status: 403 },
    ]) {
      const { check, calls } = checkerHarness({ ...opts, validTtlMs: 60_000 });
      await check('rpa_x');
      await check('rpa_x');
      await check('rpa_x');
      assert.equal(
        calls.length,
        3,
        `fail-open verdict was cached for ${JSON.stringify(opts)}`
      );
    }
  });

  it('coalesces concurrent checks for the same token into one upstream call', async () => {
    let release!: () => void;
    const gate = { wait: new Promise<void>((r) => (release = r)) };
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      gate,
    });
    const all = Promise.all([
      check('rpa_same'),
      check('rpa_same'),
      check('rpa_same'),
      check('rpa_same'),
    ]);
    release();
    const verdicts = await all;
    assert.equal(
      calls.length,
      1,
      'concurrent same-token checks were not coalesced'
    );
    assert.deepEqual(
      verdicts.map((v) => v.status),
      ['valid', 'valid', 'valid', 'valid']
    );
  });

  it('bounds the cache so one-off tokens cannot grow it without limit', async () => {
    // Eviction is otherwise lazy (only on a repeat lookup of the same token),
    // and an unauthenticated caller can present arbitrarily many distinct
    // tokens. maxEntries 2: after three tokens the first must be gone.
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      maxEntries: 2,
    });
    await check('t1');
    await check('t2');
    await check('t3');
    assert.equal(calls.length, 3);
    await check('t3'); // still cached
    assert.equal(calls.length, 3);
    await check('t1'); // evicted → re-verified
    assert.equal(calls.length, 4);
  });

  it('invalidate() drops a cached verdict so the next check re-verifies', async () => {
    const { check, invalidate, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
    });
    await check('rpa_live');
    await check('rpa_live');
    assert.equal(calls.length, 1);
    invalidate('rpa_live');
    await check('rpa_live');
    assert.equal(calls.length, 2);
    // Invalidating an unknown token is a no-op, not a throw.
    invalidate('never-seen');
  });
});

// ---- handleMcpRequest wiring: dead credential → HTTP 401 + WWW-Authenticate ----

function fakeReqRes(
  headers: Record<string, string>,
  extra: { method?: string; body?: unknown } = {}
) {
  const req = {
    method: extra.method ?? 'POST',
    url: '/mcp',
    headers: {
      host: 'mcp.test',
      'content-type': 'application/json',
      ...headers,
    },
    // Defaults to a real MCP request, which is the only shape the gate checks.
    body:
      'body' in extra
        ? extra.body
        : { jsonrpc: '2.0', method: 'tools/call', id: 1 },
  } as unknown as IncomingMessage;

  const written: {
    statusCode?: number;
    headers?: Record<string, string>;
    body?: string;
  } = {};
  const res = {
    writeHead(statusCode: number, hdrs: Record<string, string>) {
      written.statusCode = statusCode;
      written.headers = hdrs;
      return this;
    },
    end(body?: string) {
      written.body = body;
    },
    on() {},
  } as unknown as ServerResponse;

  return { req, res, written };
}

describe('handleMcpRequest — standalone GET SSE stream is refused', () => {
  // Stateless server: no server-initiated messages, so GET gets the spec's
  // 405 rather than an idle open SSE stream.
  it('GET → 405 with Allow, JSON-RPC error body, and no credential check', async () => {
    let checkerCalls = 0;
    const { req, res, written } = fakeReqRes(
      { authorization: 'Bearer rpa_x', accept: 'text/event-stream' },
      { method: 'GET' }
    );
    await handleMcpRequest(req, res, {
      verifyCredential: async () => {
        checkerCalls++;
        return { status: 'valid' as const };
      },
    });
    assert.equal(written.statusCode, 405);
    assert.equal(written.headers!['Allow'], 'POST, DELETE');
    const body = JSON.parse(written.body!) as {
      jsonrpc: string;
      error: { code: number; message: string };
    };
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.error.code, -32000);
    assert.match(body.error.message, /Method Not Allowed/);
    assert.equal(checkerCalls, 0);
  });

  it('unauthenticated GET → 405, not 401 (a 401 would trigger a pointless re-auth flow)', async () => {
    const { req, res, written } = fakeReqRes({}, { method: 'GET' });
    await handleMcpRequest(req, res, {});
    assert.equal(written.statusCode, 405);
    assert.equal(written.headers!['WWW-Authenticate'], undefined);
  });
});

describe('handleMcpRequest — credential pre-flight', () => {
  it('dead credential → HTTP 401 with WWW-Authenticate resource metadata (the re-auth trigger)', async () => {
    const { req, res, written } = fakeReqRes({
      authorization: 'Bearer rpa_dead',
    });
    await handleMcpRequest(req, res, {
      verifyCredential: async () => ({
        status: 'invalid' as const,
        reason: 'The Runpod API rejected the credential.',
      }),
    });
    assert.equal(written.statusCode, 401);
    const challenge = written.headers!['WWW-Authenticate'];
    assert.match(challenge, /^Bearer realm="mcp", /);
    assert.match(
      challenge,
      /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource"$/
    );
    // RFC 6750 3.1: a REJECTED credential carries error="invalid_token"; that is
    // what lets a client tell "re-authenticate me" from "never authenticated".
    assert.match(challenge, /error="invalid_token"/);
    const body = JSON.parse(written.body!) as { error: string };
    assert.match(body.error, /Re-authenticate to continue/);
  });

  it('missing bearer still 401s with WWW-Authenticate (pre-existing behavior, no checker call)', async () => {
    let checkerCalls = 0;
    const { req, res, written } = fakeReqRes({});
    await handleMcpRequest(req, res, {
      verifyCredential: async () => {
        checkerCalls++;
        return { status: 'valid' as const };
      },
    });
    assert.equal(written.statusCode, 401);
    const challenge = written.headers!['WWW-Authenticate'];
    assert.ok(challenge);
    // No credential was presented, so RFC 6750 3.1 requires error be ABSENT.
    // Without this the two 401s are byte-identical and indistinguishable.
    assert.equal(/error=/.test(challenge), false, challenge);
    assert.equal(checkerCalls, 0);
  });

  it('MCP_SKIP_CREDENTIAL_CHECK=true bypasses the pre-flight', async () => {
    process.env.MCP_SKIP_CREDENTIAL_CHECK = 'true';
    try {
      let checkerCalls = 0;
      const { req, res, written } = fakeReqRes({
        authorization: 'Bearer rpa_dead',
      });
      // With the check skipped the request proceeds into the MCP transport,
      // which will fail on this fake req/res — that's fine; the assertion is
      // that no 401 was written and the checker was never consulted.
      await handleMcpRequest(req, res, {
        verifyCredential: async () => {
          checkerCalls++;
          return { status: 'invalid' as const, reason: 'dead' };
        },
      }).catch(() => {});
      assert.equal(checkerCalls, 0);
      // 406, not "not 401": the request reached the MCP transport, which rejects
      // this minimal fake req for missing Accept headers. That PROVES it got past
      // the gate. `notEqual(statusCode, 401)` would also pass on undefined, i.e.
      // if the skip branch crashed before writing anything.
      assert.equal(written.statusCode, 406);
    } finally {
      delete process.env.MCP_SKIP_CREDENTIAL_CHECK;
    }
  });
});

describe('handleMcpRequest — gate self-disables on environment skew', () => {
  // The pre-flight validates against RUNPOD_AUTHED_GRAPHQL_URL while tools use the
  // REST/serverless hosts. Overriding one without the other means a dev key gets
  // checked against prod, 401s definitively, and EVERY request is rejected even
  // though the tools would work. A wrong 401 is worse than a missed one.
  const restVars = [
    'RUNPOD_REST_API_URL',
    'RUNPOD_REST_V2_API_URL',
    'RUNPOD_SERVERLESS_API_URL',
  ];

  function withEnv(
    env: Record<string, string | undefined>,
    fn: () => Promise<void>
  ): Promise<void> {
    const prev = new Map<string, string | undefined>();
    for (const k of Object.keys(env)) prev.set(k, process.env[k]);
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn().finally(() => {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  for (const v of restVars) {
    it(`skips the check when ${v} is overridden and RUNPOD_AUTHED_GRAPHQL_URL is not`, async () => {
      await withEnv(
        {
          [v]: 'https://dev.example/api',
          RUNPOD_AUTHED_GRAPHQL_URL: undefined,
        },
        async () => {
          let checkerCalls = 0;
          const { req, res, written } = fakeReqRes({
            authorization: 'Bearer rpa_dev',
          });
          await handleMcpRequest(req, res, {
            verifyCredential: async () => {
              checkerCalls++;
              return {
                status: 'invalid' as const,
                reason: 'wrong environment',
              };
            },
          }).catch(() => {});
          assert.equal(checkerCalls, 0, 'checker ran despite env skew');
          // 406 = reached the MCP transport (see the MCP_SKIP test above), so
          // the gate was skipped rather than the handler dying early.
          assert.equal(written.statusCode, 406, 'did not reach the transport');
        }
      );
    });
  }

  it('still checks when BOTH are overridden (they agree — no skew)', async () => {
    await withEnv(
      {
        RUNPOD_REST_API_URL: 'https://dev.example/api',
        RUNPOD_AUTHED_GRAPHQL_URL: 'https://dev.example/graphql',
      },
      async () => {
        let checkerCalls = 0;
        const { req, res, written } = fakeReqRes({
          authorization: 'Bearer rpa_dead',
        });
        await handleMcpRequest(req, res, {
          verifyCredential: async () => {
            checkerCalls++;
            return { status: 'invalid' as const, reason: 'dead' };
          },
        });
        assert.equal(checkerCalls, 1);
        assert.equal(written.statusCode, 401);
      }
    );
  });

  it('still checks with no overrides at all (the production default)', async () => {
    await withEnv(
      {
        RUNPOD_REST_API_URL: undefined,
        RUNPOD_REST_V2_API_URL: undefined,
        RUNPOD_SERVERLESS_API_URL: undefined,
        RUNPOD_AUTHED_GRAPHQL_URL: undefined,
      },
      async () => {
        let checkerCalls = 0;
        const { req, res, written } = fakeReqRes({
          authorization: 'Bearer rpa_dead',
        });
        await handleMcpRequest(req, res, {
          verifyCredential: async () => {
            checkerCalls++;
            return { status: 'invalid' as const, reason: 'dead' };
          },
        });
        assert.equal(checkerCalls, 1);
        assert.equal(written.statusCode, 401);
      }
    );
  });
});

describe('defaultCredentialChecker (the real one, not a stub)', () => {
  // Every other handleMcpRequest test injects a stub, so without this the
  // production checker — and the RUNPOD_AUTHED_GRAPHQL_URL wiring behind it — is never
  // exercised and a typo there ships silently.
  it('is a usable handle with verify + invalidate', () => {
    assert.equal(typeof defaultCredentialChecker.verify, 'function');
    assert.equal(typeof defaultCredentialChecker.invalidate, 'function');
    // invalidate on an unknown token must not throw.
    defaultCredentialChecker.invalidate('never-seen-token');
  });

  it('targets RUNPOD_AUTHED_GRAPHQL_URL, defaulting to the production host', async () => {
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { myself: { id: 'u' } } }),
      };
    }) as unknown as typeof globalThis.fetch;
    const prev = process.env.RUNPOD_AUTHED_GRAPHQL_URL;
    try {
      delete process.env.RUNPOD_AUTHED_GRAPHQL_URL;
      await defaultCredentialChecker.verify('tok-default-host');
      assert.equal(seen[0], 'https://api.runpod.io/graphql');

      process.env.RUNPOD_AUTHED_GRAPHQL_URL = 'https://dev.example/graphql';
      await defaultCredentialChecker.verify('tok-override-host');
      assert.equal(seen[1], 'https://dev.example/graphql');
    } finally {
      globalThis.fetch = originalFetch;
      if (prev === undefined) delete process.env.RUNPOD_AUTHED_GRAPHQL_URL;
      else process.env.RUNPOD_AUTHED_GRAPHQL_URL = prev;
      defaultCredentialChecker.invalidate('tok-default-host');
      defaultCredentialChecker.invalidate('tok-override-host');
    }
  });
});

describe('createCredentialChecker — races and eviction order', () => {
  it('invalidate() during an in-flight check is NOT undone by the late result', async () => {
    // A tool call 401s and invalidates while a pre-flight started microseconds
    // earlier is still resolving. Without an epoch guard the late `remember`
    // re-arms the stale "valid" for a full TTL and the 401 never surfaces.
    let release!: () => void;
    const gate = { wait: new Promise<void>((r) => (release = r)) };
    const { check, invalidate, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      gate,
      validTtlMs: 60_000,
    });

    const inFlight = check('rpa_live');
    invalidate('rpa_live'); // credential died while the check was pending
    release();
    await inFlight;

    // The stale verdict must not have been cached: the next check re-verifies.
    await check('rpa_live');
    assert.equal(
      calls.length,
      2,
      'late result re-armed the invalidated verdict'
    );
  });

  it('does not evict an in-flight check when the map is full', async () => {
    // At capacity, eviction used to pop the front of the map without checking for
    // a live promise, disowning a STILL-IN-FLIGHT check for another token. That
    // broke the one-in-flight-check-per-token invariant: the disowned check's
    // (fresher) verdict was dropped on settle, and the token had to re-probe — a
    // flood of distinct tokens could evict a legit user's in-flight check and let
    // a since-revoked key cache as valid. maxEntries=1 reproduces with two tokens.
    // `resolve` is the promise executor's own resolve, so it is typed by what
    // createCredentialChecker's fetch must return — not `unknown`.
    type ProbeResponse = Awaited<
      ReturnType<Parameters<typeof createCredentialChecker>[0]['fetch']>
    >;
    type PendingResolve = (r: ProbeResponse) => void;
    const pending: { token: string; resolve: PendingResolve }[] = [];
    const settle = (token: string, status: number) => {
      const i = pending.findIndex((p) => p.token === token);
      const [p] = pending.splice(i, 1);
      p.resolve({
        ok: status < 300,
        status,
        json: async () =>
          status < 300 ? { data: { myself: { id: 'u' } } } : {},
      });
    };
    const { verify } = createCredentialChecker({
      fetch: (_url, init) =>
        new Promise((resolve) =>
          pending.push({
            token: (init.headers.Authorization as string).replace(
              'Bearer ',
              ''
            ),
            resolve,
          })
        ),
      url: () => 'https://gql.test/graphql',
      maxEntries: 1,
      validTtlMs: 60_000,
      invalidTtlMs: 30_000,
    });

    const a1 = verify('A'); // in flight; will settle LATE as revoked
    const b1 = verify('B'); // must NOT evict A's in-flight entry
    settle('B', 200);
    await b1;
    settle('A', 401);
    assert.equal((await a1).status, 'invalid');

    // A must still hold its real verdict: a follow-up is a cache hit, not a
    // re-probe. Drain any stray probe first so the buggy path fails instead of
    // hanging.
    const before = pending.length;
    const a2 = verify('A');
    const reProbed = pending.length > before;
    if (reProbed) settle('A', 200); // buggy path: cache miss issued a new probe
    assert.equal((await a2).status, 'invalid');
    assert.equal(
      reProbed,
      false,
      'A was evicted mid-flight and had to re-probe'
    );
  });

  it('evicts least-recently-USED, not merely oldest-inserted', async () => {
    // A cache HIT must refresh recency. With plain insertion order, a token
    // being actively served from cache ages out while junk tokens (whose 401s
    // are definitive and therefore cached) flush the map.
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      maxEntries: 2,
    });
    await check('hot'); // [hot]
    await check('cold'); // [hot, cold]
    await check('hot'); // cache hit → recency refreshed → [cold, hot]
    assert.equal(calls.length, 2, 'the hit should not have called upstream');

    await check('new'); // evicts the LRU, which must be `cold`, not `hot`
    assert.equal(calls.length, 3);

    await check('hot'); // still cached → no new call
    assert.equal(calls.length, 3, 'hot entry was evicted despite being used');

    await check('cold'); // evicted → re-verified
    assert.equal(calls.length, 4);
  });

  it('never exceeds maxEntries', async () => {
    const one = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      maxEntries: 1,
    });
    await one.check('a');
    await one.check('a');
    assert.equal(one.calls.length, 1, 'maxEntries=1 should cache one entry');
    await one.check('b'); // evicts a
    await one.check('a');
    assert.equal(one.calls.length, 3);
  });
});

describe('env-mismatch guard keys off the RESOLVED host, not mere presence', () => {
  function withEnv2(
    env: Record<string, string | undefined>,
    fn: () => Promise<void>
  ): Promise<void> {
    const keys = [
      'RUNPOD_REST_API_URL',
      'RUNPOD_REST_V2_API_URL',
      'RUNPOD_SERVERLESS_API_URL',
      'RUNPOD_AUTHED_GRAPHQL_URL',
    ];
    const prev = new Map(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }
    return fn().finally(() => {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  async function gateRan(env: Record<string, string | undefined>) {
    let calls = 0;
    await withEnv2(env, async () => {
      const { req, res } = fakeReqRes({ authorization: 'Bearer rpa_x' });
      await handleMcpRequest(req, res, {
        verifyCredential: async () => {
          calls++;
          return { status: 'valid' as const };
        },
      }).catch(() => {});
    });
    return calls === 1;
  }

  it('still runs when a var is pinned to its own default value', async () => {
    // The regression that made the first version of this guard dangerous:
    // README documents pinning these hosts, and a value equal to the default
    // would have silently switched the whole feature off in production.
    assert.equal(
      await gateRan({ RUNPOD_REST_API_URL: 'https://rest.runpod.io/v1' }),
      true
    );
    assert.equal(
      await gateRan({ RUNPOD_REST_V2_API_URL: 'https://api.runpod.io/v2' }),
      true
    );
    assert.equal(
      await gateRan({ RUNPOD_SERVERLESS_API_URL: 'https://api.runpod.ai/v2' }),
      true
    );
  });

  it('still runs when the RETIRED v2 default host is pinned (alias, not a move)', async () => {
    // `v2-rest.runpod.io/v2` was the default before `api.runpod.io/v2` became
    // canonical, and it is the same backend. A deployment that pinned it back
    // when it WAS the default must not lose the pre-flight to a host rename.
    assert.equal(
      await gateRan({ RUNPOD_REST_V2_API_URL: 'https://v2-rest.runpod.io/v2' }),
      true
    );
  });

  it('skips when a host genuinely points elsewhere and GraphQL was left behind', async () => {
    assert.equal(
      await gateRan({ RUNPOD_REST_API_URL: 'https://api.runpod.dev/v1' }),
      false
    );
    // The alias covers the prod rename only. The dev host is a real different
    // environment — normalizing it into prod would validate dev keys against
    // prod GraphQL and 401 every request the tools could have served.
    assert.equal(
      await gateRan({
        RUNPOD_REST_V2_API_URL: 'https://v2-rest.runpod.dev/v2',
      }),
      false
    );
  });

  it('still runs when BOTH were moved (they were migrated together)', async () => {
    assert.equal(
      await gateRan({
        RUNPOD_REST_API_URL: 'https://api.runpod.dev/v1',
        RUNPOD_AUTHED_GRAPHQL_URL: 'https://api.runpod.dev/graphql',
      }),
      true
    );
  });

  it('still runs with no overrides (the production default)', async () => {
    assert.equal(await gateRan({}), true);
  });
});

describe('default TTLs', () => {
  it('a valid verdict is cached for 60s, not 5 minutes', async () => {
    // The original 5-minute window meant a revoked key kept passing the gate —
    // and failing upstream with the wrapped 200 this module exists to remove —
    // for five minutes. Pinned so the value cannot drift back silently.
    let t = 0;
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      now: () => t,
    });
    await check('rpa_live');
    t = 59_000;
    await check('rpa_live');
    assert.equal(calls.length, 1, 'should still be cached before 60s');
    t = 61_000;
    await check('rpa_live');
    assert.equal(calls.length, 2, 'should re-verify after 60s');
  });

  it('an invalid verdict is cached only briefly (30s)', async () => {
    let t = 0;
    const { check, calls } = checkerHarness({ status: 401, now: () => t });
    await check('rpa_dead');
    t = 29_000;
    await check('rpa_dead');
    assert.equal(calls.length, 1);
    t = 31_000;
    await check('rpa_dead');
    assert.equal(calls.length, 2);
  });
});

describe('the gate runs only for real MCP calls (no credential oracle)', () => {
  // Checking before the body is understood made the server a key-validation
  // oracle: any POST with a bearer and junk body answered 401-vs-not, so a
  // stranger could test stolen credentials through us, from our egress IPs,
  // past whatever per-IP limits the Runpod API applies.
  it('accepts a single JSON-RPC request and a batch of them', () => {
    assert.equal(
      bodyIsCheckable({ jsonrpc: '2.0', method: 'tools/call', id: 1 }),
      true
    );
    assert.equal(
      bodyIsCheckable([
        { jsonrpc: '2.0', method: 'tools/list', id: 1 },
        { jsonrpc: '2.0', method: 'ping', id: 2 },
      ]),
      true
    );
  });

  it('checks a batch that mixes a response with a tool call (was a bypass)', () => {
    // A JSON-RPC response element has no `method`. Under `every`, a single
    // response element marked the whole batch un-checkable while the SDK still
    // executed the tools/call inside it — a one-element opt-out of the pre-flight.
    // Any element that invokes a method must force the check.
    assert.equal(
      bodyIsCheckable([
        { jsonrpc: '2.0', id: 99, result: {} },
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
      ]),
      true
    );
    assert.equal(
      bodyIsCheckable([{ jsonrpc: '2.0', method: 'ok' }, { nope: true }]),
      true
    );
  });

  it('rejects bodies that are not MCP messages', () => {
    for (const junk of [
      {},
      { hello: 'world' },
      { jsonrpc: '1.0', method: 'x' },
      { jsonrpc: '2.0' },
      { jsonrpc: '2.0', method: 42 },
      [],
      // A batch of only responses invokes no tool, so it is correctly not checked.
      [
        { jsonrpc: '2.0', id: 1, result: {} },
        { jsonrpc: '2.0', id: 2, result: {} },
      ],
      'a string',
      null,
      42,
    ]) {
      assert.equal(
        bodyIsCheckable(junk),
        false,
        `should reject ${JSON.stringify(junk)}`
      );
    }
  });

  it('an unparsed or absent body is NOT checkable', () => {
    // Vercel returns undefined for content types it declines to parse, and plain
    // node:http never parses at all. Either way there is nothing to verify, and
    // treating it as MCP reopened the credential oracle.
    assert.equal(bodyIsCheckable(undefined), false);
  });

  it('does NOT consult the checker for a junk body', async () => {
    let calls = 0;
    const { req, res, written } = fakeReqRes(
      { authorization: 'Bearer rpa_probe' },
      { body: { probing: 'for valid keys' } }
    );
    await handleMcpRequest(req, res, {
      verifyCredential: async () => {
        calls++;
        return { status: 'invalid' as const, reason: 'dead' };
      },
    }).catch(() => {});
    assert.equal(calls, 0, 'the checker ran for a non-MCP body');
    assert.notEqual(written.statusCode, 401);
  });

  it('DOES consult the checker for a well-formed MCP body', async () => {
    let calls = 0;
    const { req, res, written } = fakeReqRes(
      { authorization: 'Bearer rpa_dead' },
      { body: { jsonrpc: '2.0', method: 'tools/call', id: 1 } }
    );
    await handleMcpRequest(req, res, {
      verifyCredential: async () => {
        calls++;
        return { status: 'invalid' as const, reason: 'dead' };
      },
    });
    assert.equal(calls, 1);
    assert.equal(written.statusCode, 401);
  });

  it('skips GET and DELETE (no authenticated upstream call to break)', async () => {
    for (const method of ['GET', 'DELETE']) {
      let calls = 0;
      const { req, res } = fakeReqRes(
        { authorization: 'Bearer rpa_dead' },
        { method }
      );
      await handleMcpRequest(req, res, {
        verifyCredential: async () => {
          calls++;
          return { status: 'invalid' as const, reason: 'dead' };
        },
      }).catch(() => {});
      assert.equal(calls, 0, `${method} should not consult the checker`);
    }
  });
});

describe('invalidate() vs in-flight checks (per-token generations)', () => {
  it('a request arriving AFTER invalidate does not receive the pre-invalidate verdict', async () => {
    // The epoch guard alone stopped the stale verdict being CACHED but not being
    // SERVED: a joiner attached to the pre-invalidate inFlight promise and got
    // back the very verdict invalidate() had just rejected, so the next request
    // still could not emit the 401.
    let release!: () => void;
    const gate = { wait: new Promise<void>((r) => (release = r)) };
    const { check, invalidate, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      gate,
      validTtlMs: 60_000,
    });

    const first = check('tok');
    invalidate('tok'); // credential died mid-flight
    const second = check('tok'); // must NOT join the doomed request
    release();
    await Promise.all([first, second]);

    assert.equal(
      calls.length,
      2,
      'the post-invalidate request reused the invalidated in-flight verdict'
    );
  });

  it("one token's invalidate does not discard another token's in-flight verdict", async () => {
    // A single global counter meant any user's invalidate threw away every other
    // user's pending result, so on a busy instance the cache never populated.
    let release!: () => void;
    const gate = { wait: new Promise<void>((r) => (release = r)) };
    const { check, invalidate, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      gate,
      validTtlMs: 60_000,
    });

    const bPending = check('tokB');
    invalidate('tokA'); // unrelated token
    release();
    await bPending;

    // B's verdict was definitive and must have been cached.
    await check('tokB');
    assert.equal(
      calls.length,
      1,
      "an unrelated invalidate discarded tokB's verdict"
    );
  });

  it('still coalesces concurrent checks when nothing is invalidated', async () => {
    let release!: () => void;
    const gate = { wait: new Promise<void>((r) => (release = r)) };
    const { check, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      gate,
    });
    const all = Promise.all([check('t'), check('t'), check('t')]);
    release();
    await all;
    assert.equal(calls.length, 1);
  });
});

describe('the gate mirrors the SDK content-type check (no bypass window)', () => {
  // The gate must run for every content type the SDK would parse and run a tool
  // for, or the gap is a bypass: gate skips, SDK executes, credential unverified.
  // The SDK uses `ct.includes('application/json')`, so json-patch+json / jsonx
  // reach a tool and MUST be checked; genuinely non-JSON types the SDK 415s stay
  // skipped (checking them would reopen the oracle Vercel's unparsed-body case
  // exposed).
  async function checkerRan(contentType: string | undefined) {
    let calls = 0;
    const { req, res } = fakeReqRes({
      authorization: 'Bearer rpa_probe',
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
    });
    // fakeReqRes defaults to application/json; drop it to test "no content-type".
    if (contentType === undefined) delete req.headers['content-type'];
    // Body deliberately left unparsed (undefined), which is what Vercel hands us
    // for any content-type it does not handle.
    await handleMcpRequest(req, res, {
      verifyCredential: async () => {
        calls++;
        return { status: 'invalid' as const, reason: 'dead' };
      },
    }).catch(() => {});
    return calls === 1;
  }

  it('skips genuinely non-JSON content-types the SDK 415s', async () => {
    for (const ct of [
      'application/xml',
      'text/csv',
      'multipart/form-data; boundary=x',
      'application/x-amz-json-1.0',
      'text/plain',
      'application/octet-stream',
      'application/x-www-form-urlencoded',
    ]) {
      assert.equal(
        await checkerRan(ct),
        false,
        `gate ran for Content-Type: ${ct}`
      );
    }
  });

  it('skips a request with no content-type at all', async () => {
    assert.equal(await checkerRan(undefined), false);
  });

  it('runs for every content-type the SDK treats as JSON (was a bypass)', async () => {
    for (const ct of [
      'application/json',
      'application/json; charset=utf-8',
      'APPLICATION/JSON',
      // The SDK's substring check accepts these and runs the tool, so an
      // exact-match gate skipping them was a one-character opt-out.
      'application/json-patch+json',
      'application/jsonx',
    ]) {
      assert.equal(
        await checkerRan(ct),
        true,
        `gate skipped Content-Type: ${ct}`
      );
    }
  });
});

describe('env-mismatch guard ignores cosmetic URL differences', () => {
  async function gateRuns(env: Record<string, string | undefined>) {
    const keys = [
      'RUNPOD_REST_API_URL',
      'RUNPOD_REST_V2_API_URL',
      'RUNPOD_SERVERLESS_API_URL',
      'RUNPOD_AUTHED_GRAPHQL_URL',
    ];
    const prev = new Map(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }
    let calls = 0;
    try {
      const { req, res } = fakeReqRes({ authorization: 'Bearer rpa_x' });
      await handleMcpRequest(req, res, {
        verifyCredential: async () => {
          calls++;
          return { status: 'valid' as const };
        },
      }).catch(() => {});
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    return calls === 1;
  }

  it('a trailing slash is not a different environment', async () => {
    assert.equal(
      await gateRuns({ RUNPOD_REST_API_URL: 'https://rest.runpod.io/v1/' }),
      true
    );
  });

  it('host casing is not a different environment', async () => {
    assert.equal(
      await gateRuns({ RUNPOD_REST_API_URL: 'https://REST.runpod.io/v1' }),
      true
    );
  });

  it('an empty-string override is treated as unset', async () => {
    assert.equal(await gateRuns({ RUNPOD_REST_API_URL: '' }), true);
    assert.equal(await gateRuns({ RUNPOD_SERVERLESS_API_URL: '' }), true);
  });

  it('a genuinely different REST host still disables the gate', async () => {
    assert.equal(
      await gateRuns({ RUNPOD_REST_API_URL: 'https://api.runpod.dev/v1' }),
      false
    );
  });

  it('moving ONLY the GraphQL host disables the gate too (reverse skew)', async () => {
    // Validating a prod key against a non-prod auth backend rejects every good
    // credential just as REST-moved-but-GraphQL-default does. The guard must be
    // bidirectional; an earlier version only caught the REST direction, so this
    // documented RUNPOD_AUTHED_GRAPHQL_URL dev override 401'd every good key.
    assert.equal(
      await gateRuns({
        RUNPOD_AUTHED_GRAPHQL_URL: 'http://127.0.0.1:9911/graphql',
      }),
      false
    );
  });

  it('runs when REST and GraphQL move together (same environment)', async () => {
    // Both sides agree they are off-default, so the pre-flight validates against
    // the same environment the tools will call — safe to run.
    assert.equal(
      await gateRuns({
        RUNPOD_REST_API_URL: 'https://api.runpod.dev/v1',
        RUNPOD_REST_V2_API_URL: 'https://api.runpod.dev/v2',
        RUNPOD_SERVERLESS_API_URL: 'https://api.runpod.dev/v2',
        RUNPOD_AUTHED_GRAPHQL_URL: 'https://api.runpod.dev/graphql',
      }),
      true
    );
  });
});

describe('buildToolContext (the hosted ToolContext handed to registerTools)', () => {
  // Previously this object was inline, and deleting its onUnauthorized field left
  // the whole suite green — the link between "a tool saw a 401" and "drop the
  // cached verdict" could be removed without any test noticing.
  const req = {
    method: 'POST',
    url: '/mcp',
    headers: { host: 'mcp.test', 'user-agent': 'test-client/1.0' },
  } as unknown as IncomingMessage;

  it('wires onUnauthorized to invalidate THIS request token', () => {
    const dropped: string[] = [];
    const ctx = buildToolContext(req, 'rpa_caller', {
      invalidateCredential: (t) => dropped.push(t),
    });
    assert.equal(typeof ctx.onUnauthorized, 'function');
    ctx.onUnauthorized!();
    assert.deepEqual(dropped, ['rpa_caller']);
  });

  it('forwards the caller identity used for tracking', () => {
    const ctx = buildToolContext(req, 'rpa_caller', { serverVersion: '9.9.9' });
    assert.equal(ctx.apiKey, 'rpa_caller');
    assert.equal(ctx.transport, 'http');
    assert.equal(ctx.clientUserAgent, 'test-client/1.0');
    assert.equal(ctx.serverVersion, '9.9.9');
  });
});

describe('credential_check log line', () => {
  // The log is the only way an operator can tell the gate is rejecting everyone
  // or has silently stopped running, so anomalies must always be recorded. The
  // happy path is the bulk of traffic and is gated behind MCP_VERBOSE_LOGS.
  async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      if (args[0] === 'credential_check') {
        lines.push((args[1] as { outcome: string }).outcome);
      }
    };
    try {
      await fn();
    } finally {
      console.log = original;
    }
    return lines;
  }

  function outcomeFor(
    reqHeaders: Record<string, string>,
    valid: boolean,
    method = 'POST'
  ): Promise<string[]> {
    return captureLogs(async () => {
      const { req, res } = fakeReqRes(reqHeaders, { method });
      await handleMcpRequest(req, res, {
        verifyCredential: async () =>
          valid
            ? ({ status: 'valid' } as const)
            : ({ status: 'invalid', reason: 'r' } as const),
      }).catch(() => {});
    });
  }

  it('always logs a rejection', async () => {
    assert.deepEqual(
      await outcomeFor({ authorization: 'Bearer dead' }, false),
      ['reject']
    );
  });

  it('distinguishes each skip reason', async () => {
    // DELETE: GET is answered 405 before the gate runs.
    assert.deepEqual(
      await outcomeFor({ authorization: 'Bearer x' }, true, 'DELETE'),
      ['skip_not_post']
    );
    assert.deepEqual(
      await outcomeFor(
        { authorization: 'Bearer x', 'content-type': 'application/xml' },
        true
      ),
      ['skip_not_json']
    );

    process.env.MCP_SKIP_CREDENTIAL_CHECK = 'true';
    try {
      assert.deepEqual(await outcomeFor({ authorization: 'Bearer x' }, true), [
        'skip_env_var',
      ]);
    } finally {
      delete process.env.MCP_SKIP_CREDENTIAL_CHECK;
    }
  });

  it('stays quiet on the happy path unless MCP_VERBOSE_LOGS is set', async () => {
    assert.deepEqual(
      await outcomeFor({ authorization: 'Bearer ok' }, true),
      []
    );
    process.env.MCP_VERBOSE_LOGS = 'true';
    try {
      assert.deepEqual(await outcomeFor({ authorization: 'Bearer ok' }, true), [
        'pass',
      ]);
    } finally {
      delete process.env.MCP_VERBOSE_LOGS;
    }
  });
});

describe('repeated invalidate/verify cycles stay correct', () => {
  // NOTE: this pins the BEHAVIOUR, not the related memory fix. `invalidate()` only
  // bumps a generation when something is in flight, because bumping otherwise left
  // an entry no `finally` would ever clear — an unbounded leak in the very map
  // added to prevent one. That leak is invisible from outside the module, so no
  // test here can catch it; the guard is asserted by the comment in invalidate()
  // and by review, not by this test. Do not read a pass here as proof of it.
  it('a verdict is cacheable again after an invalidate', async () => {
    const { check, invalidate, calls } = checkerHarness({
      jsonBody: { data: { myself: { id: 'u' } } },
      validTtlMs: 60_000,
    });
    for (let i = 0; i < 5; i++) {
      await check('tok');
      invalidate('tok');
    }
    assert.equal(calls.length, 5, 'each cycle should re-verify');

    // After the last invalidate, a fresh verify must be cacheable again — proof
    // the generation counter is not stuck above what verify() captures.
    await check('tok');
    await check('tok');
    assert.equal(calls.length, 6, 'the post-invalidate verdict was not cached');
  });
});

describe('a disowned in-flight check cannot resurrect a rejected verdict', () => {
  it('a slow check that settles AFTER a newer one does not clobber it', async () => {
    // The race the generation counter got wrong: A starts, the credential is
    // revoked and invalidated, B starts and answers 401 first, then A settles late
    // with its pre-invalidation "valid". A must be disowned — otherwise the
    // revoked credential passes the gate for a full TTL, which is the exact bug
    // the invalidate path exists to prevent. Entry identity handles it; the
    // counter did not, because B's cleanup reset it to the value A had captured.
    let releaseA!: () => void;
    let releaseB!: () => void;
    const waitA = new Promise<void>((r) => (releaseA = r));
    const waitB = new Promise<void>((r) => (releaseB = r));

    let call = 0;
    const handle = createCredentialChecker({
      fetch: async () => {
        call += 1;
        if (call === 1) {
          await waitA; // A: slow, and answers with the pre-revocation verdict
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { myself: { id: 'u' } } }),
          };
        }
        await waitB; // B: fast, and sees the credential is gone
        return { ok: false, status: 401, json: async () => ({}) };
      },
      url: () => 'https://graphql.test/graphql',
      validTtlMs: 60_000,
      invalidTtlMs: 60_000,
    });

    const a = handle.verify('tok'); // (1) in flight
    handle.invalidate('tok'); // (2) tool 401 → disown A
    const b = handle.verify('tok'); // (3) fresh check

    releaseB();
    assert.equal(
      (await b).status,
      'invalid',
      'B should see the revoked credential'
    );
    releaseA();
    assert.equal(
      (await a).status,
      'valid',
      'A still returns to its own caller'
    );

    // The cached answer must be B's rejection, not A's stale pass.
    const after = await handle.verify('tok');
    assert.equal(
      after.status,
      'invalid',
      "A's stale verdict overwrote B's rejection"
    );
    assert.equal(call, 2, 'no extra upstream call was needed');
  });
});

describe('a disowned in-flight check cannot delete a newer entry', () => {
  it('a late INDETERMINATE result does not evict a fresh cached verdict', async () => {
    // The subtler half of the same race, and the one that actually needs the
    // identity check. A settles late with an indeterminate (fail-open) answer,
    // whose handler deletes the map entry so a guess is never cached. Without the
    // identity guard it deletes whatever is there NOW — B's freshly cached, valid
    // verdict — silently costing an upstream round trip on every later request.
    let releaseA!: () => void;
    const waitA = new Promise<void>((r) => (releaseA = r));

    let call = 0;
    const handle = createCredentialChecker({
      fetch: async () => {
        call += 1;
        if (call === 1) {
          await waitA;
          return { ok: false, status: 503, json: async () => ({}) }; // indeterminate
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { myself: { id: 'u' } } }),
        };
      },
      url: () => 'https://graphql.test/graphql',
      validTtlMs: 60_000,
    });

    const a = handle.verify('tok'); // (1) in flight, will fail open
    handle.invalidate('tok'); // (2) disown it
    await handle.verify('tok'); // (3) B answers valid and is cached
    assert.equal(call, 2);

    releaseA();
    await a; // A settles late; its cleanup must not touch B's entry

    await handle.verify('tok');
    assert.equal(call, 2, "A's cleanup deleted B's cached verdict");
  });
});

describe('env guard compares the GraphQL host too, not just its presence', () => {
  it('setting RUNPOD_AUTHED_GRAPHQL_URL to the prod default does not satisfy the guard', async () => {
    // Routine ops practice is to set every variable explicitly, including to its
    // default. Testing mere presence meant that satisfied the guard while REST
    // pointed at dev — so a dev key was checked against prod, came back a
    // definitive 401, and EVERY request was rejected though the tools worked.
    const keys = [
      'RUNPOD_REST_API_URL',
      'RUNPOD_REST_V2_API_URL',
      'RUNPOD_SERVERLESS_API_URL',
      'RUNPOD_AUTHED_GRAPHQL_URL',
    ];
    const prev = new Map(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.RUNPOD_REST_API_URL = 'https://rest.dev.runpod.io/v1';
    process.env.RUNPOD_AUTHED_GRAPHQL_URL = 'https://api.runpod.io/graphql'; // the default
    let calls = 0;
    try {
      const { req, res } = fakeReqRes({ authorization: 'Bearer rpa_dev' });
      await handleMcpRequest(req, res, {
        verifyCredential: async () => {
          calls++;
          return { status: 'invalid' as const, reason: 'wrong environment' };
        },
      }).catch(() => {});
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    assert.equal(calls, 0, 'the gate ran against the wrong environment');
  });
});

describe('an unknown verdict lets the request through', () => {
  it('does NOT 401 when the checker could not reach a conclusion', async () => {
    // 'unknown' is the fail-open state: the auth backend was unreachable, slow, or
    // answered something unrecognised. Rejecting on it would turn any blip in that
    // backend into a 401 for every caller — and a spurious 401 makes clients
    // re-run OAuth, minting a new API key each time.
    let logged: string | undefined;
    const original = console.log;
    console.log = (...args: unknown[]) => {
      if (args[0] === 'credential_check') {
        logged = (args[1] as { outcome: string }).outcome;
      }
    };
    const { req, res, written } = fakeReqRes({ authorization: 'Bearer rpa_x' });
    try {
      await handleMcpRequest(req, res, {
        verifyCredential: async () => ({ status: 'unknown' as const }),
      }).catch(() => {});
    } finally {
      console.log = original;
    }
    assert.notEqual(
      written.statusCode,
      401,
      'failed closed on an unknown verdict'
    );
    // And it is logged distinctly from a real pass, so an auth-backend outage is
    // visible rather than looking like healthy traffic.
    assert.equal(logged, 'fail_open');
  });
});
