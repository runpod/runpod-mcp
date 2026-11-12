import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { handleMcpRequest, parseTeamIdHeader } from '#src/http';

// ============== Team scope: the X-Team-Id request header ==============
// REST v2 scopes a Console (Clerk JWT) call to a team with X-Team-Id
// (spec securitySchemes.bearerAuth). The hosted server takes the team from
// the inbound request header only, never from a tool argument: the Console
// owns team context, and a model-chosen team is a wrong-account risk.

const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

class FakeResponse extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  constructor(private readonly finish: () => void) {
    super();
  }
  writeHead(statusCode: number, hdrs?: Record<string, string>) {
    this.statusCode = statusCode;
    Object.assign(this.headers, hdrs ?? {});
    return this;
  }
  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers[name] = String(value);
    return this;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(String(chunk));
    return true;
  }
  end(chunk?: string) {
    if (chunk !== undefined) this.chunks.push(String(chunk));
    this.writableFinished = true;
    this.emit('finish');
    this.finish();
  }
}

function fakeReqRes(body: unknown, extraHeaders: object = {}) {
  const req = {
    method: 'POST',
    url: '/',
    headers: {
      host: 'mcp.test',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer rpa_x',
      'user-agent': 'probe/0',
      ...extraHeaders,
    },
    body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fake = new FakeResponse(finish);
  return { req, res: fake as unknown as ServerResponse, fake, finished };
}

const reqWith = (value: string | string[] | undefined) =>
  ({
    headers: value === undefined ? {} : { 'x-team-id': value },
  }) as unknown as IncomingMessage;

describe('parseTeamIdHeader', () => {
  it('absent header → no team', () => {
    assert.deepEqual(parseTeamIdHeader(reqWith(undefined)), {
      teamId: undefined,
    });
  });

  it('a plain id → that team', () => {
    for (const id of ['cm1abc2def3', 'team_01-AB', 'a'.repeat(128)]) {
      assert.deepEqual(parseTeamIdHeader(reqWith(id)), { teamId: id });
    }
  });

  it('empty, spaced, listed, oversized or repeated → invalid', () => {
    for (const value of [
      '',
      '   ',
      ' cm1abc',
      'a b',
      'a,b',
      'a, b',
      'a'.repeat(129),
      'tëam',
      '../x',
      ['a', 'b'],
    ]) {
      assert.deepEqual(
        parseTeamIdHeader(reqWith(value)),
        { invalid: true },
        `for ${JSON.stringify(value)}`
      );
    }
  });
});

describe('handleMcpRequest — X-Team-Id', () => {
  it('a malformed header is refused with 400 before the credential check', async () => {
    let verified = false;
    const { req, res, fake, finished } = fakeReqRes(toolsList, {
      'x-team-id': 'a, b',
    });
    await handleMcpRequest(req, res, {
      verifyCredential: async () => {
        verified = true;
        return { status: 'valid' as const };
      },
    });
    await finished;
    assert.equal(fake.statusCode, 400);
    assert.equal(verified, false);
    const parsed = JSON.parse(fake.chunks.join('')) as {
      error: { message: string };
    };
    assert.match(parsed.error.message, /X-Team-Id/);
  });

  it('a well-formed header is served', async () => {
    const { req, res, fake, finished } = fakeReqRes(toolsList, {
      'x-team-id': 'cm1abc2def3',
    });
    await handleMcpRequest(req, res, {
      verifyCredential: async () => ({ status: 'valid' as const }),
    });
    await finished;
    assert.equal(fake.statusCode, 200);
  });
});
