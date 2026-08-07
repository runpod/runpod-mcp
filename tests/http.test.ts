import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import nodeFetch from 'node-fetch';

import {
  clampTimeout,
  createHttpClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  HttpError,
  MIN_REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
} from '../src/_shared/http.js';
import {
  sanitizeUaToken,
  buildTrackingHeaders,
} from '../src/_shared/tracking.js';
import {
  HTTP_TRANSPORT_BUDGET_MS,
  invocationBudget,
} from '../src/tools/runtime.js';
import {
  HTTP_LONG_POLL_BUDGET_MS,
  HTTP_STREAM_POLL_WAIT_MS,
  MAX_CONSECUTIVE_STREAM_ERRORS,
  MIN_STREAM_POLL_TIMEOUT_MS,
  STDIO_STREAM_BUDGET_MS,
  STREAM_UPSTREAM_DEFAULT_WAIT_MS,
  streamPollTimeoutMs,
  UPSTREAM_HOLD_SLACK_MS,
} from '../src/tools/jobs.js';

// ---- fake response/fetch builders (no network) ----
interface FakeResponseOpts {
  ok?: boolean;
  status?: number;
  contentType?: string | null;
  jsonBody?: unknown;
  textBody?: string;
}

function fakeResponse(opts: FakeResponseOpts) {
  const status = opts.status ?? 200;
  // Respect an explicit `contentType: null`; only default when the key is absent.
  const contentType =
    'contentType' in opts ? opts.contentType : 'application/json';
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? (contentType ?? null) : null,
    },
    json: async () => opts.jsonBody,
    text: async () => opts.textBody ?? '',
  };
}

type Captured = {
  url?: string;
  init?: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  };
};

function fakeFetch(resp: ReturnType<typeof fakeResponse>, captured?: Captured) {
  return async (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    }
  ) => {
    if (captured) {
      captured.url = url;
      captured.init = init;
    }
    return resp;
  };
}

const noTracking = () => ({});

describe('createHttpClient — request shape', () => {
  it('passes the resolved URL through unchanged', async () => {
    const cap: Captured = {};
    const client = createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
    });
    await client('https://rest.runpod.io/v1/pods');
    assert.equal(cap.url, 'https://rest.runpod.io/v1/pods');
  });

  it('sets Authorization bearer + Content-Type + tracking headers', async () => {
    const cap: Captured = {};
    const client = createHttpClient({
      apiKey: 'rpa_abc',
      fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
      tracking: () => ({ 'User-Agent': 'ua/1', 'X-Runpod-Session-Id': 'sid' }),
      errorPrefix: 'Runpod API Error',
    });
    await client('http://x/pods');
    assert.equal(cap.init?.headers.Authorization, 'Bearer rpa_abc');
    assert.equal(cap.init?.headers['Content-Type'], 'application/json');
    assert.equal(cap.init?.headers['User-Agent'], 'ua/1');
    assert.equal(cap.init?.headers['X-Runpod-Session-Id'], 'sid');
  });

  it('defaults method to GET and sends no body', async () => {
    const cap: Captured = {};
    const client = createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
      tracking: noTracking,
      errorPrefix: 'p',
    });
    await client('http://x/pods');
    assert.equal(cap.init?.method, 'GET');
    assert.equal(cap.init?.body, undefined);
  });

  it('serializes body only for POST/PATCH', async () => {
    for (const method of ['POST', 'PATCH']) {
      const cap: Captured = {};
      const client = createHttpClient({
        apiKey: 'k',
        fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
        tracking: noTracking,
        errorPrefix: 'p',
      });
      await client('http://x/pods', method, { name: 'a' });
      assert.equal(cap.init?.body, JSON.stringify({ name: 'a' }), method);
    }
  });

  it('does NOT serialize a body for GET/DELETE (gate is POST/PATCH/PUT)', async () => {
    for (const method of ['GET', 'DELETE']) {
      const cap: Captured = {};
      const client = createHttpClient({
        apiKey: 'k',
        fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
        tracking: noTracking,
        errorPrefix: 'p',
      });
      await client('http://x/pods', method, { name: 'a' });
      assert.equal(cap.init?.body, undefined, method);
    }
  });

  it('DOES serialize a body for POST/PATCH/PUT', async () => {
    for (const method of ['POST', 'PATCH', 'PUT']) {
      const cap: Captured = {};
      const client = createHttpClient({
        apiKey: 'k',
        fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
        tracking: noTracking,
        errorPrefix: 'p',
      });
      await client('http://x/pods', method, { name: 'a' });
      assert.equal(cap.init?.body, JSON.stringify({ name: 'a' }), method);
    }
  });

  it('invokes tracking() on every request (not memoized) — session id stays per-call', async () => {
    let n = 0;
    const client = createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(fakeResponse({ jsonBody: {} })),
      tracking: () => ({ 'X-Runpod-Session-Id': String(++n) }),
      errorPrefix: 'p',
    });
    // capture per call
    const seen: string[] = [];
    const capClient = createHttpClient({
      apiKey: 'k',
      fetch: async (_url, init) => {
        seen.push(init.headers['X-Runpod-Session-Id']);
        return fakeResponse({ jsonBody: {} });
      },
      tracking: () => ({ 'X-Runpod-Session-Id': String(++n) }),
      errorPrefix: 'p',
    });
    await client('http://x');
    await capClient('http://x');
    await capClient('http://x');
    assert.equal(seen.length, 2);
    assert.notEqual(
      seen[0],
      seen[1],
      'tracking must be re-evaluated per request'
    );
  });
});

describe('createHttpClient — response handling', () => {
  const mk = (resp: ReturnType<typeof fakeResponse>) =>
    createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(resp),
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
    });

  it('parses an application/json body', async () => {
    const out = await mk(fakeResponse({ jsonBody: { id: 'p1' } }))('http://x');
    assert.deepEqual(out, { id: 'p1' });
  });

  it('parses a generic +json vendor content-type on success', async () => {
    const out = await mk(
      fakeResponse({
        status: 200,
        contentType: 'application/vnd.api+json',
        jsonBody: { data: 1 },
      })
    )('http://x');
    assert.deepEqual(out, { data: 1 });
  });

  it('matches application/json with a charset suffix, case-insensitively', async () => {
    const a = await mk(
      fakeResponse({
        contentType: 'application/json; charset=utf-8',
        jsonBody: { a: 1 },
      })
    )('http://x');
    assert.deepEqual(a, { a: 1 });
    const b = await mk(
      fakeResponse({ contentType: 'Application/JSON', jsonBody: { b: 2 } })
    )('http://x');
    assert.deepEqual(b, { b: 2 });
  });

  it('!ok with problem+json: reads body via .text(), never .json(), surfaces it on HttpError.body', async () => {
    let jsonCalls = 0;
    const resp = {
      ok: false,
      status: 400,
      headers: { get: () => 'application/problem+json' },
      json: async () => {
        jsonCalls++;
        return { detail: 'should not be read' };
      },
      text: async () => '{"detail":"bad request","status":400}',
    };
    const client = createHttpClient({
      apiKey: 'k',
      fetch: async () => resp,
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
    });
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 400);
        assert.equal(err.body, '{"detail":"bad request","status":400}');
        return true;
      }
    );
    assert.equal(jsonCalls, 0, 'error path must not call .json()');
  });

  it('204 / empty / non-JSON → { success: true, status }', async () => {
    const out = await mk(fakeResponse({ status: 204, contentType: null }))(
      'http://x'
    );
    assert.deepEqual(out, { success: true, status: 204 });

    const out2 = await mk(
      fakeResponse({ status: 200, contentType: 'text/plain' })
    )('http://x');
    assert.deepEqual(out2, { success: true, status: 200 });
  });

  it('!ok → throws HttpError carrying status + body + prefix', async () => {
    const client = mk(
      fakeResponse({ status: 404, ok: false, textBody: 'not found' })
    );
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.name, 'HttpError');
        assert.equal(err.status, 404);
        assert.equal(err.body, 'not found');
        assert.match(err.message, /^Runpod API Error: 404 - not found$/);
        return true;
      }
    );
  });

  it('501 throws an HttpError with status 501 (so create-pod can branch, stream-job still counts it)', async () => {
    const client = mk(
      fakeResponse({ status: 501, ok: false, textBody: 'not implemented' })
    );
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => err instanceof HttpError && err.status === 501
    );
  });

  it('error prefix is configurable per client (serverless vs rest)', async () => {
    const client = createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(
        fakeResponse({ status: 500, ok: false, textBody: 'boom' })
      ),
      tracking: noTracking,
      errorPrefix: 'Runpod Serverless API Error',
    });
    await assert.rejects(
      () => client('http://x'),
      /Runpod Serverless API Error: 500 - boom$/
    );
  });
});

// Pins the deadline, the per-call override runsync needs, the platform
// ceiling, and the error text the agent actually reads. Why it exists: see the
// REQUEST DEADLINE block in _shared/http.ts.
describe('createHttpClient — request deadline', () => {
  // Rejects on the caller's signal, as a real fetch does; a fake that ignored
  // it would make the deadline unobservable.
  // AbortSignal.timeout's timer is unref'd — fine in production, where a real
  // socket holds the loop, but these fakes do no I/O. Without something ref'd
  // pending, Node 18 drains the loop and CANCELS the test rather than letting
  // the deadline fire. Released as soon as the abort lands.
  const KEEP_ALIVE_MS = 500;
  const onAbort = (signal?: AbortSignal): Promise<never> => {
    const keepAlive = setTimeout(() => {}, KEEP_ALIVE_MS);
    const promise = new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () =>
        reject(signal.reason ?? new Error('aborted'))
      );
    });
    promise.catch(() => {}).finally(() => clearTimeout(keepAlive));
    return promise;
  };

  // Accepts the connection and then says nothing — the wedged-server case.
  const silentFetch = (_url: string, init: { signal?: AbortSignal }) =>
    onAbort(init.signal);

  // Answers, but slowly — the shape of a legitimately long call (runsync).
  const slowFetch =
    (ms: number, body: unknown) =>
    (_url: string, init: { signal?: AbortSignal }) =>
      Promise.race([
        onAbort(init.signal),
        new Promise<ReturnType<typeof fakeResponse>>((resolve) =>
          setTimeout(() => resolve(fakeResponse({ jsonBody: body })), ms)
        ),
      ]);

  const mkClient = (extra: {
    fetch: Parameters<typeof createHttpClient>[0]['fetch'];
    defaultTimeoutMs?: number;
    maxTimeoutMs?: Parameters<typeof createHttpClient>[0]['maxTimeoutMs'];
  }) =>
    createHttpClient({
      apiKey: 'k',
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
      ...extra,
    });

  it('attaches a deadline signal to every request', async () => {
    const cap: Captured = {};
    const client = mkClient({
      fetch: fakeFetch(fakeResponse({ jsonBody: {} }), cap),
    });
    await client('http://x');
    assert.ok(
      cap.init?.signal instanceof AbortSignal,
      'no request may go out unbounded'
    );
    assert.equal(cap.init?.signal.aborted, false);
  });

  it('the default deadline is well under the hosted 60s function limit', () => {
    assert.ok(
      DEFAULT_REQUEST_TIMEOUT_MS < 60_000,
      'a default at or past maxDuration would still surface as a bare 504'
    );
  });

  it('the default fires on a silent server and names itself, the API, and the method', async () => {
    const client = mkClient({ fetch: silentFetch, defaultTimeoutMs: 5 });
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => {
        assert.ok(err instanceof RequestTimeoutError);
        assert.equal(err.name, 'RequestTimeoutError');
        assert.equal(err.timeoutMs, 5);
        assert.equal(err.method, 'GET');
        assert.match(err.message, /^Runpod API Error: no response after 5ms /);
        return true;
      }
    );
  });

  // The message is the agent's entire input on a timeout, and we abandoned the
  // request without undoing it. On a write it may well have landed, and there
  // is no idempotency key upstream to deduplicate a retry — so "retry" is only
  // ever safe advice for a read.
  it('a timed-out write warns against blind retry; a read says retrying is safe', async () => {
    const client = mkClient({ fetch: silentFetch, defaultTimeoutMs: 5 });

    await assert.rejects(
      () => client('http://x', 'POST', { name: 'p' }),
      (err: unknown) => {
        assert.ok(err instanceof RequestTimeoutError);
        assert.equal(err.method, 'POST');
        assert.match(err.message, /may have SUCCEEDED upstream/);
        assert.match(err.message, /do not retry blindly/);
        return true;
      }
    );

    await assert.rejects(
      () => client('http://x', 'GET'),
      (err: unknown) => {
        assert.ok(err instanceof RequestTimeoutError);
        assert.match(err.message, /retrying is safe/);
        assert.equal(
          /SUCCEEDED/.test(err.message),
          false,
          'a read must not carry the write warning'
        );
        return true;
      }
    );

    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      await assert.rejects(
        () => client('http://x', method, { a: 1 }),
        (err: unknown) =>
          err instanceof RequestTimeoutError &&
          /do not retry blindly/.test(err.message),
        `${method} must be treated as a write`
      );
    }
  });

  it('the error prefix follows the client (serverless vs rest)', async () => {
    const client = createHttpClient({
      apiKey: 'k',
      fetch: silentFetch,
      tracking: noTracking,
      errorPrefix: 'Runpod Serverless API Error',
      defaultTimeoutMs: 5,
    });
    await assert.rejects(
      () => client('http://x'),
      /Runpod Serverless API Error: no response after 5ms /
    );
  });

  it('a per-call timeoutMs shortens the deadline', async () => {
    const client = mkClient({ fetch: silentFetch, defaultTimeoutMs: 10_000 });
    await assert.rejects(
      () => client('http://x', 'GET', undefined, { timeoutMs: 5 }),
      (err: unknown) =>
        err instanceof RequestTimeoutError && err.timeoutMs === 5
    );
  });

  it('a per-call timeoutMs lengthens it — the runsync case, where the default would truncate a wait the caller asked for', async () => {
    const client = mkClient({
      fetch: slowFetch(60, { id: 'job_1' }),
      defaultTimeoutMs: 5,
    });
    const out = await client('http://x', 'POST', {}, { timeoutMs: 5_000 });
    assert.deepEqual(out, { id: 'job_1' });
  });

  it('maxTimeoutMs caps an override (the hosted platform budget)', async () => {
    const client = mkClient({
      fetch: silentFetch,
      defaultTimeoutMs: 10_000,
      maxTimeoutMs: 5,
    });
    await assert.rejects(
      () => client('http://x', 'GET', undefined, { timeoutMs: 300_000 }),
      (err: unknown) =>
        err instanceof RequestTimeoutError && err.timeoutMs === 5
    );
  });

  // A per-request deadline bounds one wedged socket. It does NOT bound a handler
  // that makes two calls, and several do (get-job-status, deploy-hub-repo,
  // update-endpoint) — so a thunk ceiling reports what is left of the whole
  // invocation and each request is clamped to the remainder.
  // Asserted on clampTimeout rather than through a client: the deadline a
  // request was given is otherwise only observable by waiting for it to fire,
  // and the floor is a full second by design.
  it('a decaying ceiling hands each successive call only the remainder', () => {
    let remaining = 50_000;
    const ceiling = () => remaining;
    assert.equal(clampTimeout(undefined, ceiling, 30_000), 30_000);
    remaining = 20_000; // as if that first 30s call had been spent in full
    assert.equal(
      clampTimeout(undefined, ceiling, 30_000),
      20_000,
      'a second call handed a fresh 30s is exactly the two-call 504 this closes'
    );
  });

  it('an exhausted ceiling floors rather than aborting before it connects', () => {
    // A 0ms or negative deadline reports "no response after 0ms", which reads
    // as a server fault rather than a budget we had already spent.
    assert.equal(
      clampTimeout(undefined, () => 0),
      MIN_REQUEST_TIMEOUT_MS
    );
    assert.equal(
      clampTimeout(undefined, () => -5_000),
      MIN_REQUEST_TIMEOUT_MS
    );
  });

  it('a static ceiling is left exactly as configured — only the decaying thunk is floored', () => {
    // The floor exists for a budget that ran out on its own. A number someone
    // wrote down is not that, and silently raising it would be the surprise
    // (this suite's own 5ms ceilings depend on it).
    assert.equal(clampTimeout(300_000, 5), 5);
    assert.equal(
      clampTimeout(300_000, () => 5),
      MIN_REQUEST_TIMEOUT_MS
    );
  });

  it('the client re-reads the ceiling on every request instead of capturing it once', async () => {
    // The counterpart to the arithmetic above: a ceiling resolved once at
    // construction would let every request in an invocation claim the full
    // allowance no matter what earlier ones had already spent.
    let reads = 0;
    const client = mkClient({
      fetch: fakeFetch(fakeResponse({ jsonBody: {} })),
      maxTimeoutMs: () => {
        reads += 1;
        return 30_000;
      },
    });
    await client('http://x');
    await client('http://x');
    assert.equal(reads, 2);
  });

  it('a network failure is not relabelled as a timeout', async () => {
    const client = mkClient({
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => {
        assert.ok(!(err instanceof RequestTimeoutError));
        assert.match((err as Error).message, /ECONNREFUSED/);
        return true;
      }
    );
  });
});

describe('tracking headers', () => {
  it('sanitizeUaToken strips reserved chars and bounds length', () => {
    assert.equal(sanitizeUaToken('claude (code)'), 'claude__code_');
    assert.equal(sanitizeUaToken('a'.repeat(100)).length, 64);
  });

  it('sanitizeUaToken: 64 passes unchanged, 65 truncates to 64 (boundary)', () => {
    assert.equal(sanitizeUaToken('a'.repeat(64)), 'a'.repeat(64));
    assert.equal(sanitizeUaToken('a'.repeat(65)).length, 64);
  });

  it('sanitizeUaToken: all-reserved → underscores, empty → empty', () => {
    assert.equal(sanitizeUaToken('(),;'), '____');
    assert.equal(sanitizeUaToken(''), '');
  });

  it('uses unknown for an empty-string clientName/clientVersion (|| not ??)', () => {
    const h = buildTrackingHeaders({
      clientName: '',
      clientVersion: '',
      transport: 'stdio',
      serverVersion: '1.0.0',
      sessionId: 's',
    });
    assert.match(h['User-Agent'], /client=unknown; client_version=unknown/);
  });

  it('builds the structured UA + session id', () => {
    const h = buildTrackingHeaders({
      clientName: 'Cursor',
      clientVersion: '1.2.3',
      transport: 'stdio',
      serverVersion: '1.3.0',
      sessionId: 'sid-1',
    });
    assert.equal(
      h['User-Agent'],
      'runpod-mcp-server/1.3.0 (caller=mcp; client=Cursor; client_version=1.2.3; transport=stdio)'
    );
    assert.equal(h['X-Runpod-Session-Id'], 'sid-1');
  });

  it('falls back to unknown when client identity is missing', () => {
    const h = buildTrackingHeaders({
      transport: 'http',
      serverVersion: 'dev',
      sessionId: 's',
    });
    assert.match(
      h['User-Agent'],
      /client=unknown; client_version=unknown; transport=http/
    );
  });
});

// A 429 reaches the client's error through the shared hint builder; these pin
// the wiring (which headers are read), not the hint's own wording.
describe('createHttpClient — 429 hint wiring', () => {
  const HEADER = '"minute";r=12;t=44, "hour";r=0;t=1724, "day";r=31839;t=23324';

  it('a 429 response carries the parsed hint on the error message', async () => {
    const resp = {
      ok: false,
      status: 429,
      headers: {
        get: (n: string) => (n.toLowerCase() === 'ratelimit' ? HEADER : null),
      },
      json: async () => ({}),
      text: async () => '{"detail":"rate limit exceeded for the hour window"}',
    };
    const client = createHttpClient({
      apiKey: 'k',
      fetch: async () => resp,
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
    });
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 429);
        assert.match(err.message, /the hour quota is exhausted/);
        assert.match(err.message, /wait ~29 minutes \(1724s\)/);
        // status/body stay clean for programmatic callers.
        assert.equal(
          err.body,
          '{"detail":"rate limit exceeded for the hour window"}'
        );
        return true;
      }
    );
  });

  it('the client reads Retry-After off the response, not just RateLimit', async () => {
    const resp = {
      ok: false,
      status: 429,
      headers: {
        get: (n: string) => {
          const name = n.toLowerCase();
          if (name === 'ratelimit') return '"minute";r=0;t=12, "hour";r=0;t=60';
          if (name === 'retry-after') return '900';
          return null;
        },
      },
      json: async () => ({}),
      text: async () => '{"detail":"rate limit exceeded"}',
    };
    const client = createHttpClient({
      apiKey: 'k',
      fetch: async () => resp,
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
    });
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.match(err.message, /the hour quota is exhausted/);
        assert.match(err.message, /wait ~15 minutes \(900s\)/);
        return true;
      }
    );
  });

  it('non-429 errors carry no rate-limit hint', async () => {
    const client = createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(
        fakeResponse({ status: 500, ok: false, textBody: 'boom' })
      ),
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
    });
    await assert.rejects(
      () => client('http://x'),
      /Runpod API Error: 500 - boom$/
    );
  });

  it('a 401 carries the re-auth hint (every request this client sends is credentialed)', async () => {
    // The hint moved out of the HttpError constructor (the public GraphQL
    // path must be able to omit it), so this pins that the REST client still
    // wires it in — without it, a stdio agent with a revoked key gets a bare
    // "401 - Unauthorized" and nothing actionable.
    const client = createHttpClient({
      apiKey: 'k',
      fetch: fakeFetch(
        fakeResponse({ status: 401, ok: false, textBody: 'Unauthorized' })
      ),
      tracking: noTracking,
      errorPrefix: 'Runpod API Error',
    });
    await assert.rejects(
      () => client('http://x'),
      (err: unknown) => {
        assert.ok(err instanceof HttpError);
        assert.equal(err.status, 401);
        assert.match(err.message, /expired or revoked/);
        return true;
      }
    );
  });
});

// The backstop is only correct relative to two numbers in two other files. It
// must stay under the platform limit (or it never fires) and above any
// server-side wait a tool asks for (or it aborts a reply that was in flight).
describe('the http request backstop sits between the waits it brackets', () => {
  const maxDuration = (
    JSON.parse(
      readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
    ) as { functions?: Record<string, { maxDuration?: number }> }
  ).functions?.['api/index.ts']?.maxDuration;

  it('leaves the platform room for the pre-flight that runs before any tool request', () => {
    assert.ok(
      typeof maxDuration === 'number',
      'vercel.json no longer declares a maxDuration for api/index.ts'
    );
    // The platform clock starts before ours: src/http.ts awaits the credential
    // pre-flight (4s, credential-check.ts) before dispatching the tool, and it
    // burns that full budget in the same outage that stalls the tool call. The
    // remainder covers cold start and serializing the error. Measuring from the
    // request instead of the invocation is what put this at 55s originally.
    const PRE_FLIGHT_MS = 4_000;
    const SERIALIZE_AND_COLD_START_MS = 5_000;
    assert.ok(
      HTTP_TRANSPORT_BUDGET_MS + PRE_FLIGHT_MS + SERIALIZE_AND_COLD_START_MS <=
        maxDuration * 1000,
      `HTTP_TRANSPORT_BUDGET_MS (${HTTP_TRANSPORT_BUDGET_MS}) + pre-flight (${PRE_FLIGHT_MS}) + serialization (${SERIALIZE_AND_COLD_START_MS}) exceeds maxDuration (${maxDuration}s) — the backstop would fire after the platform already reaped the function`
    );
  });

  it('the budget window is per construction, so each request starts it over', async () => {
    // The whole scheme rests on the runtime being rebuilt per request, which on
    // http it is (src/http.ts builds a single-use server + registerTools inside
    // the handler). Pinned here because hoisting that out — a tempting
    // cold-start optimization — would leave every request after the first
    // running on the floor.
    const first = invocationBudget(1_000);
    const before = first();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const after = first();
    assert.ok(
      after < before,
      'the window must decay as the invocation is spent'
    );

    const second = invocationBudget(1_000);
    assert.ok(
      second() > after,
      'a freshly constructed runtime must get a fresh allowance, not the previous request’s remainder'
    );
  });

  it('leaves a second call something to spend, since several handlers make two', () => {
    // get-job-status, deploy-hub-repo, update-endpoint and set-endpoint-gpus all
    // issue two requests. The shared budget is what keeps their worst case under
    // the platform limit, but that only helps if the ceiling is bigger than one
    // full default — otherwise the first call takes everything and the second is
    // left on the floor, which is a timeout dressed up as a diagnosis.
    assert.ok(
      HTTP_TRANSPORT_BUDGET_MS > DEFAULT_REQUEST_TIMEOUT_MS,
      `HTTP_TRANSPORT_BUDGET_MS (${HTTP_TRANSPORT_BUDGET_MS}) is not above one ${DEFAULT_REQUEST_TIMEOUT_MS}ms default, so a two-call handler's second request starts already exhausted`
    );
  });

  it('clears the longest server-side wait by the slack runsync actually adds', () => {
    // runsync asks the Serverless API to hold the connection open for
    // HTTP_LONG_POLL_BUDGET_MS and sets its deadline that much plus
    // UPSTREAM_HOLD_SLACK_MS. Assert against both real constants: restating
    // a smaller literal here would let the ceiling silently clamp the slack
    // away — the deadline would land on the hold and abort a reply in flight.
    assert.ok(
      HTTP_TRANSPORT_BUDGET_MS >=
        HTTP_LONG_POLL_BUDGET_MS + UPSTREAM_HOLD_SLACK_MS,
      `HTTP_TRANSPORT_BUDGET_MS (${HTTP_TRANSPORT_BUDGET_MS}) is below the ${HTTP_LONG_POLL_BUDGET_MS}ms hold plus its ${UPSTREAM_HOLD_SLACK_MS}ms slack, so the clamp eats the slack`
    );
  });
});

describe('stream-job poll deadline', () => {
  // The transports differ only in the hold each poll brackets: http caps it with
  // ?wait=, stdio takes the server's default. Both are read from the source, so
  // moving either constant moves these assertions with it.
  const CASES = [
    {
      transport: 'http',
      budgetMs: HTTP_LONG_POLL_BUDGET_MS,
      holdMs: HTTP_STREAM_POLL_WAIT_MS,
    },
    {
      transport: 'stdio',
      budgetMs: STDIO_STREAM_BUDGET_MS,
      holdMs: STREAM_UPSTREAM_DEFAULT_WAIT_MS,
    },
  ] as const;

  for (const { transport, budgetMs, holdMs } of CASES) {
    it(`on ${transport}: clears the hold it brackets, so a reply in flight is never aborted`, () => {
      // A deadline at or below the hold cannot be met: the server does not
      // answer until its wait elapses, and the reply still needs a round trip.
      const deadline = streamPollTimeoutMs(budgetMs, holdMs);
      assert.ok(
        deadline > holdMs,
        `poll deadline ${deadline}ms does not clear the ${holdMs}ms hold, so every slow poll aborts a response already on its way`
      );
    });

    it(`on ${transport}: leaves room for the retry loop instead of spending the budget in one attempt`, () => {
      // The regression this pins: a deadline set TO the remaining budget means
      // one wedged socket consumes the whole run, MAX_CONSECUTIVE_STREAM_ERRORS
      // never engages, and a stall that the loop was built to survive returns
      // nothing. Reconnecting is the only recovery, so the budget has to fit
      // several attempts.
      const deadline = streamPollTimeoutMs(budgetMs, holdMs);
      assert.ok(
        deadline < budgetMs,
        `poll deadline ${deadline}ms is the entire ${budgetMs}ms budget — a single wedged poll ends the run`
      );
      const attempts = Math.floor(budgetMs / deadline);
      assert.ok(
        attempts >= MAX_CONSECUTIVE_STREAM_ERRORS,
        `a wedged socket allows only ${attempts} attempts inside the ${budgetMs}ms budget, below the ${MAX_CONSECUTIVE_STREAM_ERRORS} the error counter needs to ever fire`
      );
    });
  }

  it('never outlives what is left of the budget', () => {
    // Between the hold and the budget the budget wins: overshooting it just
    // hands the platform reaper the timeout we were trying to report.
    // Above the floor (which is what a nearly-spent budget hits) and below the
    // hold-derived deadline, so the budget is the only thing that can be
    // binding here.
    const remaining = MIN_STREAM_POLL_TIMEOUT_MS + 1;
    assert.ok(remaining < HTTP_STREAM_POLL_WAIT_MS + UPSTREAM_HOLD_SLACK_MS);
    assert.equal(
      streamPollTimeoutMs(remaining, HTTP_STREAM_POLL_WAIT_MS),
      remaining
    );
  });

  it('floors a spent budget rather than asking for 0ms', () => {
    // A 0ms (or negative) deadline aborts before the socket opens and reports
    // "no response after 0ms", which reads as a server fault rather than time
    // we had already spent. The budget check after the poll ends the loop.
    for (const remaining of [0, -5_000]) {
      assert.equal(
        streamPollTimeoutMs(remaining, HTTP_STREAM_POLL_WAIT_MS),
        MIN_STREAM_POLL_TIMEOUT_MS
      );
    }
  });
});

// ============== real node-fetch, real socket ==============
// Everything above injects a fake fetch, and `defaultFetch = fetch as HttpFetch`
// (src/tools/runtime.ts) is a CAST — nothing type-checks the init object against
// node-fetch's own RequestInit. If node-fetch ignored the `signal` field, every
// deadline in this release would be inert and every test above would still pass.
// So this one drives the real client, over a real socket, against a server that
// answers and one that never does.
describe('createHttpClient against real node-fetch', () => {
  let server: http.Server;
  let baseUrl: string;
  let stall = false;
  const stalled: http.ServerResponse[] = [];

  before(async () => {
    server = http.createServer((_req, res) => {
      if (stall) {
        // Accept, send nothing. The shape node-fetch has no answer for.
        stalled.push(res);
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve())
    );
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const res of stalled) res.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  const client = () =>
    createHttpClient({
      apiKey: 'rpa_test',
      // The production default, not a fake: this is the whole point.
      fetch: nodeFetch as unknown as Parameters<
        typeof createHttpClient
      >[0]['fetch'],
      tracking: () => ({}),
      errorPrefix: 'Runpod API Error',
    });

  it('passes a normal response through untouched', async () => {
    stall = false;
    assert.deepEqual(await client()(`${baseUrl}/ok`), { ok: true });
  });

  // Bounded: if node-fetch ever stops honoring the signal this hangs rather
  // than fails, and node:test has no default timeout.
  it(
    'aborts a wedged socket and names it, rather than hanging',
    { timeout: 5_000 },
    async () => {
      stall = true;
      const startedAt = Date.now();
      await assert.rejects(
        client()(`${baseUrl}/wedged`, 'GET', undefined, { timeoutMs: 150 }),
        (error: unknown) => {
          assert.ok(error instanceof RequestTimeoutError);
          assert.match(error.message, /no response after 150ms for GET/);
          return true;
        }
      );
      assert.ok(
        Date.now() - startedAt < 5_000,
        'node-fetch did not honor the signal — the deadline is inert in production'
      );
    }
  );
});
