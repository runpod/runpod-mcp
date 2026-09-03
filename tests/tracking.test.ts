// Tracking-header unit tests, re-homed from the deleted tests/http.test.ts
// (its subject, _shared/http.ts, lost every production importer to the
// specgen migration; _shared/tracking.ts is still live via specgen/context).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeUaToken,
  buildTrackingHeaders,
} from '../src/_shared/tracking.js';

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
