import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';

import handler from '../api/index.js';
import { handleMcpRequest } from '../src/http.js';

// The hosted 401 tells an OAuth-capable client to re-authenticate via the
// WWW-Authenticate header. Browsers hide every non-safelisted response header
// from JavaScript unless the server lists it in Access-Control-Expose-Headers,
// so without that entry the whole re-auth mechanism is invisible to a
// browser-based MCP client — present and inert.
//
// These run over a REAL socket. An earlier version asserted against a fake
// `writeHead` that merged headers, which meant it would have passed even if
// Node clobbered previously-set headers instead of merging them — i.e. it proved
// nothing about the behaviour it claimed to pin.

async function withServer<T>(
  listener: Parameters<typeof createServer>[1],
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server: Server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('CORS exposure of the re-auth header (real socket)', () => {
  it('a 401 carries WWW-Authenticate AND still exposes it via CORS', async () => {
    // Mirrors the hosted path: api/index.ts sets the CORS headers with
    // setHeader(), then handleMcpRequest writes the 401 with writeHead(). The
    // question this pins is whether the setHeader values survive that writeHead.
    const received = await withServer(
      async (req, res) => {
        // Vercel populates req.body before delegating; emulate that.
        (req as { body?: unknown }).body = {
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 1,
        };
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader(
          'Access-Control-Expose-Headers',
          'Mcp-Session-Id, Content-Type, WWW-Authenticate'
        );
        await handleMcpRequest(req, res, {
          verifyCredential: async () => ({
            status: 'invalid' as const,
            reason: 'The credential was rejected.',
          }),
        }).catch(() => {});
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer rpa_dead',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 1 }),
        });
        return {
          status: response.status,
          challenge: response.headers.get('www-authenticate'),
          exposed: response.headers.get('access-control-expose-headers'),
          origin: response.headers.get('access-control-allow-origin'),
        };
      }
    );

    assert.equal(received.status, 401);
    assert.ok(received.challenge, 'no WWW-Authenticate on the wire');
    assert.match(received.challenge!, /error="invalid_token"/);
    // The point of the test: the CORS header set before writeHead is still there.
    assert.ok(received.exposed, 'Expose-Headers was clobbered by writeHead');
    assert.match(received.exposed!, /WWW-Authenticate/);
    assert.equal(received.origin, '*');
  });

  it('a request with no credential omits error= but keeps the challenge', async () => {
    const received = await withServer(
      async (req, res) => {
        await handleMcpRequest(req, res).catch(() => {});
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/`, { method: 'POST' });
        return {
          status: response.status,
          challenge: response.headers.get('www-authenticate'),
        };
      }
    );
    assert.equal(received.status, 401);
    assert.match(
      received.challenge!,
      /^Bearer realm="mcp", resource_metadata=/
    );
    assert.equal(/error=/.test(received.challenge!), false);
  });
});

describe('api/index.ts sets the expose-headers list', () => {
  it('includes WWW-Authenticate alongside the pre-existing entries', async () => {
    const state: Record<string, string> = {};
    const req = {
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
      headers: { host: 'mcp.test' },
    } as unknown as Parameters<typeof handler>[0];
    const res = {
      setHeader(name: string, value: string) {
        state[name] = value;
        return this;
      },
      getHeader(name: string) {
        return state[name];
      },
      status() {
        return this;
      },
      json() {
        return this;
      },
      send() {
        return this;
      },
      end() {
        return this;
      },
      writeHead() {
        return this;
      },
      on() {},
    } as unknown as Parameters<typeof handler>[1];

    await handler(req, res).catch(() => {});
    const exposed = state['Access-Control-Expose-Headers'];
    assert.ok(exposed, 'no Access-Control-Expose-Headers set');
    assert.match(exposed, /WWW-Authenticate/);
    assert.match(exposed, /Mcp-Session-Id/);
    assert.match(exposed, /Content-Type/);
  });
});

// The published ./http export and scripts/serve-http.local.ts run on plain
// node:http, which does not populate req.body. An earlier version of this work
// required a host-supplied body, which silently disabled the pre-flight for those
// consumers — a regression against what this PR originally shipped.
describe('the gate runs on a host that does not pre-parse bodies', () => {
  it('401s a dead credential over plain node:http', async () => {
    const received = await withServer(
      async (req, res) => {
        await handleMcpRequest(req, res, {
          verifyCredential: async () => ({
            status: 'invalid' as const,
            reason: 'The credential was rejected.',
          }),
        }).catch(() => {});
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer rpa_dead',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 1 }),
        });
        return {
          status: response.status,
          challenge: response.headers.get('www-authenticate'),
        };
      }
    );
    assert.equal(received.status, 401, 'the pre-flight did not run');
    assert.match(received.challenge!, /error="invalid_token"/);
  });

  it('a junk body over plain node:http is still not checked', async () => {
    let checked = 0;
    const status = await withServer(
      async (req, res) => {
        await handleMcpRequest(req, res, {
          verifyCredential: async () => {
            checked++;
            return { status: 'invalid' as const, reason: 'dead' };
          },
        }).catch(() => {});
      },
      async (baseUrl) =>
        (
          await fetch(`${baseUrl}/`, {
            method: 'POST',
            headers: {
              authorization: 'Bearer rpa_probe',
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ probing: 'for live keys' }),
          })
        ).status
    );
    assert.equal(checked, 0, 'a non-MCP body reached the checker');
    assert.notEqual(status, 401);
  });

  it('rejects an oversized body with 413 without buffering it or checking', async () => {
    // readJsonBody replaces the SDK's own getRawBody on this path, so it must
    // enforce the same 4mb cap; without it an unauthenticated caller could stream
    // unbounded bytes into memory. The cap is honoured before the credential
    // check runs.
    let checked = 0;
    const oversized = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { pad: 'A'.repeat(5 * 1024 * 1024) },
    });
    const status = await withServer(
      async (req, res) => {
        await handleMcpRequest(req, res, {
          verifyCredential: async () => {
            checked++;
            return { status: 'valid' as const };
          },
        }).catch(() => {});
      },
      async (baseUrl) =>
        (
          await fetch(`${baseUrl}/`, {
            method: 'POST',
            headers: {
              authorization: 'Bearer rpa_x',
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: oversized,
          })
        ).status
    );
    assert.equal(status, 413, 'oversized body was not rejected with 413');
    assert.equal(checked, 0, 'the checker ran on an oversized body');
  });

  it('does not hold the request slot open for a slow non-JSON body', async () => {
    // A non-JSON content type is skipped before the body is read, so an
    // incomplete upload cannot hang inside readJsonBody — the SDK answers its own
    // 4xx promptly. Reading every body up front held the slot until the platform
    // timeout (a slowloris lever). "Responded fast" = any bytes back within 2s.
    const respondedFast = await withServer(
      async (req, res) => {
        await handleMcpRequest(req, res).catch(() => {});
      },
      (baseUrl) =>
        new Promise<boolean>((resolve) => {
          const { port, hostname } = new URL(baseUrl);
          const sock = net.connect(Number(port), hostname);
          let done = false;
          const finish = (v: boolean) => {
            if (!done) {
              done = true;
              sock.destroy();
              resolve(v);
            }
          };
          sock.on('data', () => finish(true));
          sock.on('error', () => finish(false));
          // Declares 1000 bytes, sends 4, then goes idle.
          sock.write(
            'POST / HTTP/1.1\r\nHost: x\r\n' +
              'Authorization: Bearer rpa_x\r\n' +
              'Content-Type: application/xml\r\nContent-Length: 1000\r\n\r\nAAAA'
          );
          setTimeout(() => finish(false), 2000);
        })
    );
    assert.equal(
      respondedFast,
      true,
      'a slow non-JSON body held the request slot open'
    );
  });
});

describe('browser MCP preflight', () => {
  it('allows protocol negotiation and analytics opt-out headers on the wire', async () => {
    const requested = [
      'authorization',
      'content-type',
      'mcp-session-id',
      'mcp-protocol-version',
      'x-runpod-analytics',
    ];
    await withServer(
      async (req, res) => {
        const vercelRes = Object.assign(res, {
          status(code: number) {
            res.statusCode = code;
            return res;
          },
        });
        await handler(
          req as Parameters<typeof handler>[0],
          vercelRes as unknown as Parameters<typeof handler>[1]
        );
      },
      async (baseUrl) => {
        const response = await fetch(baseUrl, {
          method: 'OPTIONS',
          headers: {
            origin: 'https://browser-client.example',
            'access-control-request-method': 'POST',
            'access-control-request-headers': requested.join(', '),
          },
        });
        assert.equal(response.status, 204);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        const allowed = response.headers
          .get('access-control-allow-headers')!
          .toLowerCase()
          .split(/,\s*/);
        for (const header of requested)
          assert.ok(allowed.includes(header), `${header} blocked by CORS`);
        assert.ok(
          response.headers.get('access-control-allow-methods')!.includes('POST')
        );
      }
    );
  });
});
