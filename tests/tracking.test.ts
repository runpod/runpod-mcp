// Tracking-header unit tests, re-homed from the deleted tests/http.test.ts
// (its subject, _shared/http.ts, lost every production importer to the
// specgen migration; _shared/tracking.ts is still live via specgen/context).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeUaToken, buildTrackingHeaders } from '#src/_shared/tracking';
import { createToolContext } from '#src/specgen/context';

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

  it('sanitizeUaToken keeps every RFC 9110 token character', () => {
    const tchars = "!#$%&'*+-.^_`|~0123456789ABCXYZabcxyz";
    assert.equal(sanitizeUaToken(tchars), tchars);
  });

  it('sanitizeUaToken maps non-ASCII and control characters to _', () => {
    assert.equal(sanitizeUaToken('クロード'), '____');
    assert.equal(sanitizeUaToken('🤖 agent'), '__agent');
    assert.equal(sanitizeUaToken('a\u0000b\u007fc'), 'a_b_c');
    assert.equal(sanitizeUaToken('café'), 'caf_');
  });

  it('a CJK, emoji or NUL client name still builds valid headers', () => {
    for (const clientName of ['クロード', '🤖 agent', 'a\u0000b']) {
      const h = buildTrackingHeaders({
        clientName,
        clientVersion: '1.0-β',
        transport: 'stdio',
        serverVersion: '1.0.0',
        sessionId: 's',
      });
      assert.doesNotThrow(() => new Headers(h), JSON.stringify(clientName));
      assert.match(h['User-Agent'], /client=[^;]+; client_version=1\.0-_;/);
    }
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
      'runpod-mcp-server/1.3.0 (caller=mcp; surface=v2; client=Cursor; client_version=1.2.3; transport=stdio)'
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

describe('createToolContext — tracking User-Agent outbound', () => {
  it('a non-ASCII client name from the handshake goes out sanitized', async () => {
    const original = globalThis.fetch;
    const seen: Array<string | null> = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const request = new Request(input, init);
      seen.push(request.headers.get('user-agent'));
      const isGraphql = request.url.endsWith('/graphql');
      return new Response(isGraphql ? '{"data":{}}' : '[]', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const ctx = createToolContext({
        apiKey: 'rpa_x',
        sdkRetry: false,
        tracking: { transport: 'stdio', serverVersion: '1.0.0' },
      });
      assert.ok(ctx.setClientInfo);
      ctx.setClientInfo('クロード', '2.0');
      await ctx.sdk.GET('/v2/pods');
      await ctx.graphql.public('{ x }');
      const ua =
        'runpod-mcp-server/1.0.0 (caller=mcp; surface=v2; client=____; client_version=2.0; transport=stdio)';
      assert.deepEqual(seen, [ua, ua]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
