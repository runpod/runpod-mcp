import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';

import {
  bodyIsCheckable,
  handleMcpRequest,
  parseMcpMessages,
  prefersJsonResponse,
  requestLogSampleRate,
  summarizeRpc,
} from '#src/http';
import { responseHoldingTools } from '#src/specgen/server';

// ============== Response mode: JSON for the handshake, SSE for tool calls ==============
// The CDN compresses application/json and never text/event-stream, so every
// request answers as JSON except a call to a tool that holds its response open:
// clients read SSE under their long stream timeout but JSON under the short
// request timeout, and those tools can legitimately run past it.

const init = (
  clientInfo: Record<string, unknown> = { name: 'probe', version: '0' }
) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo },
});
const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const toolsCall = (name: string) => ({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name, arguments: {} },
});
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const response = { jsonrpc: '2.0', id: 1, result: {} };

describe('parseMcpMessages', () => {
  it('keeps the elements the SDK would accept and drops the rest', () => {
    assert.equal(parseMcpMessages(toolsList).length, 1);
    assert.equal(parseMcpMessages([init(), initialized, response]).length, 3);
    // The SDK answers 400 for a batch with a junk element, so dropping it here
    // changes nothing a tool could observe; the valid request still gates.
    assert.equal(parseMcpMessages([toolsCall('x'), 'junk']).length, 1);
    assert.equal(bodyIsCheckable([toolsCall('x'), 'junk']), true);
  });

  it('absent, host-unparsed, or non-MCP bodies yield nothing', () => {
    for (const body of [
      undefined,
      null,
      'junk',
      42,
      {},
      [],
      { jsonrpc: '1.0', method: 'x' },
    ]) {
      assert.deepEqual(
        parseMcpMessages(body),
        [],
        `for ${JSON.stringify(body)}`
      );
    }
  });
});

describe('prefersJsonResponse', () => {
  const prefers = (body: unknown) =>
    prefersJsonResponse(parseMcpMessages(body));

  it('handshake, listing and ping requests → JSON', () => {
    assert.equal(prefers(init()), true);
    assert.equal(prefers(toolsList), true);
    assert.equal(prefers({ jsonrpc: '2.0', id: 9, method: 'ping' }), true);
    assert.equal(prefers([init(), initialized]), true);
  });

  it('a notification-only batch → JSON (the SDK answers it with an empty 202)', () => {
    assert.equal(prefers([initialized]), true);
  });

  it('a call to an ordinary tool → JSON, so its result compresses', () => {
    assert.equal(prefers(toolsCall('list-pods')), true);
    assert.equal(prefers(toolsCall('no-such-tool')), true);
  });

  it('a call to a response-holding tool, alone or in a batch → SSE', () => {
    for (const name of responseHoldingTools) {
      assert.equal(prefers(toolsCall(name)), false, name);
    }
    assert.equal(prefers([toolsList, toolsCall('stream-job')]), false);
  });

  it('the response-holding set is exactly the long-poll and stream tools', () => {
    assert.deepEqual([...responseHoldingTools].sort(), [
      'deploy-hub-repo',
      'get-job-status',
      'runsync-endpoint',
      'stream-job',
      'stream-pod-logs',
      'stream-worker-logs',
    ]);
  });

  it("no parsed messages keeps the SDK's SSE default", () => {
    assert.equal(prefers(undefined), false);
    assert.equal(prefers('junk'), false);
    assert.equal(prefers([]), false);
  });
});

describe('summarizeRpc', () => {
  const summarize = (body: unknown) => summarizeRpc(parseMcpMessages(body));

  it('initialize → method plus the client name/version', () => {
    assert.deepEqual(summarize(init({ name: 'claude-code', version: '2.1' })), {
      rpc: 'initialize',
      client: 'claude-code/2.1',
    });
  });

  it('an initialize the SDK would reject reports no client', () => {
    // clientInfo.version is required by the schema; a client omitting it never
    // completes the handshake, so there is no identity worth logging.
    assert.deepEqual(summarize(init({ name: 'cursor' })), {
      rpc: 'initialize',
      client: undefined,
    });
  });

  it('tools/call carries the tool name; a batch is comma-joined', () => {
    assert.deepEqual(summarize(toolsCall('list-pods')), {
      rpc: 'tools/call:list-pods',
      client: undefined,
    });
    assert.equal(
      summarize([init(), initialized, toolsList]).rpc,
      'initialize,notifications/initialized,tools/list'
    );
  });

  it('response elements and empty bodies', () => {
    assert.equal(summarize(response).rpc, 'response');
    assert.deepEqual(summarize(undefined), {
      rpc: undefined,
      client: undefined,
    });
    assert.deepEqual(summarize('junk'), { rpc: undefined, client: undefined });
  });
});

describe('requestLogSampleRate', () => {
  it('defaults to 10%; the env var overrides and is clamped to [0, 1]', () => {
    assert.equal(requestLogSampleRate({}), 0.1);
    assert.equal(
      requestLogSampleRate({ MCP_REQUEST_LOG_SAMPLE_RATE: '0.25' }),
      0.25
    );
    assert.equal(requestLogSampleRate({ MCP_REQUEST_LOG_SAMPLE_RATE: '0' }), 0);
    assert.equal(requestLogSampleRate({ MCP_REQUEST_LOG_SAMPLE_RATE: '7' }), 1);
    assert.equal(
      requestLogSampleRate({ MCP_REQUEST_LOG_SAMPLE_RATE: '-1' }),
      0
    );
  });

  it('garbage falls back to the default; verbose logs everything', () => {
    assert.equal(
      requestLogSampleRate({ MCP_REQUEST_LOG_SAMPLE_RATE: 'lots' }),
      0.1
    );
    assert.equal(
      requestLogSampleRate({ MCP_REQUEST_LOG_SAMPLE_RATE: '' }),
      0.1
    );
    assert.equal(
      requestLogSampleRate({
        MCP_VERBOSE_LOGS: 'true',
        MCP_REQUEST_LOG_SAMPLE_RATE: '0',
      }),
      1
    );
  });
});

// ---- handleMcpRequest end to end against the real SDK transport ----

interface Written {
  statusCode?: number;
  headers?: Record<string, string>;
  chunks: string[];
}

// Enough of ServerResponse for the SDK transport and the request log: headers,
// body writes, and the 'finish' event the log line waits for.
class FakeResponse extends EventEmitter {
  statusCode = 200;
  writableFinished = false;
  constructor(
    private readonly written: Written,
    private readonly finish: () => void
  ) {
    super();
  }
  writeHead(statusCode: number, hdrs?: Record<string, string>) {
    this.statusCode = statusCode;
    this.written.statusCode = statusCode;
    this.written.headers = { ...(this.written.headers ?? {}), ...(hdrs ?? {}) };
    return this;
  }
  setHeader(name: string, value: string | number | readonly string[]) {
    this.written.headers = {
      ...(this.written.headers ?? {}),
      [name]: String(value),
    };
    return this;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.written.chunks.push(String(chunk));
    return true;
  }
  end(chunk?: string) {
    if (chunk !== undefined) this.written.chunks.push(String(chunk));
    this.writableFinished = true;
    this.emit('finish');
    this.finish();
  }
}

function fakeReqRes(body: unknown) {
  const req = {
    method: 'POST',
    url: '/',
    headers: {
      host: 'mcp.test',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer rpa_x',
      'user-agent': 'probe/0',
      'x-real-ip': '203.0.113.9',
    },
    body,
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;

  const written: Written = { chunks: [] };
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const res = new FakeResponse(written, finish) as unknown as ServerResponse;
  return { req, res, written, finished };
}

const validCredential = async () => ({ status: 'valid' as const });

describe('handleMcpRequest — response mode', () => {
  it('tools/list answers application/json with the full tool list', async () => {
    const { req, res, written, finished } = fakeReqRes(toolsList);
    await handleMcpRequest(req, res, { verifyCredential: validCredential });
    await finished;
    assert.equal(written.statusCode, 200);
    assert.equal(written.headers?.['Content-Type'], 'application/json');
    const parsed = JSON.parse(written.chunks.join('')) as {
      id: number;
      result: { tools: Array<{ name: string }> };
    };
    assert.equal(parsed.id, 2);
    assert.ok(parsed.result.tools.length > 10);
  });

  it('initialize answers application/json', async () => {
    const { req, res, written, finished } = fakeReqRes(init());
    await handleMcpRequest(req, res, { verifyCredential: validCredential });
    await finished;
    assert.equal(written.headers?.['Content-Type'], 'application/json');
    const parsed = JSON.parse(written.chunks.join('')) as {
      id: number;
      result: { serverInfo: { name: string } };
    };
    assert.equal(parsed.id, 1);
    assert.ok(parsed.result.serverInfo.name);
  });

  it('a batch with a junk element is refused whole, not served in part', async () => {
    // parseMcpMessages drops the element on the strength of the SDK rejecting
    // the whole batch; this pins the SDK's half of that bargain.
    const { req, res, written, finished } = fakeReqRes([toolsList, 'junk']);
    await handleMcpRequest(req, res, { verifyCredential: validCredential });
    await finished;
    assert.equal(written.statusCode, 400);
    const parsed = JSON.parse(written.chunks.join('')) as {
      error?: { code: number };
      result?: unknown;
    };
    assert.equal(parsed.error?.code, -32700);
    assert.equal(parsed.result, undefined);
  });

  it('tools/call for an ordinary tool answers application/json', async () => {
    // An unknown tool errors inside the server, so no outbound call is made.
    const { req, res, written, finished } = fakeReqRes(
      toolsCall('no-such-tool')
    );
    await handleMcpRequest(req, res, { verifyCredential: validCredential });
    await finished;
    assert.equal(written.statusCode, 200);
    assert.equal(written.headers?.['Content-Type'], 'application/json');
    assert.match(written.chunks.join(''), /no-such-tool/);
  });

  it('tools/call for a response-holding tool stays on text/event-stream', async () => {
    // Missing required arguments fail the argument gate before any upstream
    // call, so the stream carries an error result without touching the API.
    const { req, res, written, finished } = fakeReqRes(
      toolsCall('get-job-status')
    );
    await handleMcpRequest(req, res, { verifyCredential: validCredential });
    await finished;
    assert.equal(written.statusCode, 200);
    assert.equal(written.headers?.['Content-Type'], 'text/event-stream');
    const stream = written.chunks.join('');
    assert.match(stream, /^event: message\ndata: /m);
    assert.match(stream, /"id":3/);
  });
});

// ---- the mcp_request log line ----

interface RequestLogLine {
  method?: string;
  status?: number;
  durationMs?: number;
  rpc?: string;
  client?: string;
  ua?: string;
  caller?: string;
  ip?: string;
  sampleRate?: number;
}

// Forces full sampling and captures only mcp_request lines, restoring both after.
async function captureRequestLog(
  run: () => Promise<void>
): Promise<RequestLogLine[]> {
  const previousRate = process.env.MCP_REQUEST_LOG_SAMPLE_RATE;
  process.env.MCP_REQUEST_LOG_SAMPLE_RATE = '1';
  const original = console.log;
  const lines: RequestLogLine[] = [];
  console.log = (...args: unknown[]) => {
    if (args[0] === 'mcp_request') lines.push(args[1] as RequestLogLine);
    else original(...args);
  };
  try {
    await run();
  } finally {
    console.log = original;
    if (previousRate === undefined)
      delete process.env.MCP_REQUEST_LOG_SAMPLE_RATE;
    else process.env.MCP_REQUEST_LOG_SAMPLE_RATE = previousRate;
  }
  return lines;
}

describe('mcp_request log line', () => {
  it('carries what was asked and by whom, never the raw key or address', async () => {
    const lines = await captureRequestLog(async () => {
      const { req, res, finished } = fakeReqRes(toolsList);
      await handleMcpRequest(req, res, { verifyCredential: validCredential });
      await finished;
    });
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.equal(line.method, 'POST');
    assert.equal(line.status, 200);
    assert.equal(line.rpc, 'tools/list');
    assert.equal(line.ua, 'probe/0');
    assert.equal(line.sampleRate, 1);
    assert.equal(typeof line.durationMs, 'number');
    assert.match(line.caller ?? '', /^[0-9a-f]{12}$/);
    assert.match(line.ip ?? '', /^[0-9a-f]{12}$/);
    const serialized = JSON.stringify(line);
    assert.doesNotMatch(serialized, /rpa_x/);
    assert.doesNotMatch(serialized, /203\.0\.113\.9/);
  });

  it('a rejected credential still logs the attempted method', async () => {
    const lines = await captureRequestLog(async () => {
      const { req, res, finished } = fakeReqRes(toolsList);
      await handleMcpRequest(req, res, {
        verifyCredential: async () => ({
          status: 'invalid' as const,
          reason: 'revoked',
        }),
      });
      await finished;
    });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].status, 401);
    assert.equal(lines[0].rpc, 'tools/list');
  });
});

// ---- the referral ask on the handshake (CON-1762; docs/agent-learning-protocol.md, "RT4") ----
// On initialize the handler asks the sink whether the account has already
// answered and drops the ask from the instructions when it has. Covers when the
// lookup runs, what it is keyed on, and that an unknown verdict keeps the ask.

async function handshake(opts: {
  body?: unknown;
  accountId?: string;
  answered: boolean | null;
}) {
  const calls: Array<[string, string]> = [];
  const { req, res, written, finished } = fakeReqRes(opts.body ?? init());
  await handleMcpRequest(req, res, {
    verifyCredential: async () => ({
      status: 'valid' as const,
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
    }),
    hasAnswered: async (identity, route) => {
      calls.push([identity, route]);
      return opts.answered;
    },
  });
  await finished;
  assert.equal(written.statusCode, 200);
  const parsed = JSON.parse(written.chunks.join('')) as {
    result: { instructions?: string };
  };
  return { calls, instructions: parsed.result.instructions ?? '' };
}

const PROMPT = /ONE QUESTION FOR YOU, ONCE PER ACCOUNT/;

describe('the referral ask on the hosted handshake', () => {
  // Self-contained env: the sink configured, and the pre-flight kill switch
  // off so verifyCredential (and with it accountId) is reached.
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const key of [
      'ALP_SINK_URL',
      'ALP_SINK_SECRET',
      'MCP_SKIP_CREDENTIAL_CHECK',
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.ALP_SINK_URL = 'https://sink.convex.site/alp/submit';
    process.env.ALP_SINK_SECRET = 'shh';
  });
  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('asks the sink once per initialize, keyed on the resolved account, and drops the prompt when answered', async () => {
    const { calls, instructions } = await handshake({
      accountId: 'acct_1',
      answered: true,
    });
    assert.deepEqual(calls, [['acct_1', 'referral']]);
    assert.doesNotMatch(instructions, PROMPT);
    assert.match(
      instructions,
      /CONTRIBUTING BACK IS OPTIONAL/,
      'the rest of the ALP briefing is unaffected'
    );
  });

  it('keeps the prompt for an account that has not answered', async () => {
    const { calls, instructions } = await handshake({
      accountId: 'acct_2',
      answered: false,
    });
    assert.deepEqual(calls, [['acct_2', 'referral']]);
    assert.match(instructions, PROMPT);
  });

  it('an unknown verdict keeps the prompt: fail-soft toward asking', async () => {
    const { instructions } = await handshake({
      accountId: 'acct_3',
      answered: null,
    });
    assert.match(instructions, PROMPT);
  });

  it('without a resolved account there is nothing to key on: no lookup, prompt kept', async () => {
    const { calls, instructions } = await handshake({ answered: true });
    assert.deepEqual(calls, []);
    assert.match(instructions, PROMPT);
  });

  it('tools/list never triggers the lookup', async () => {
    const { calls } = await handshake({
      body: toolsList,
      accountId: 'acct_4',
      answered: true,
    });
    assert.deepEqual(calls, []);
  });
});

describe('the referral ask when ALP is not configured', () => {
  // The kill switch is cleared too, so a resolved account is what proves the
  // gate is alpConfigured and not a skipped pre-flight.
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const key of [
      'ALP_SINK_URL',
      'ALP_SINK_SECRET',
      'MCP_SKIP_CREDENTIAL_CHECK',
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[key] = value;
    }
  });

  it('makes no lookup and delivers no ask, even with a resolved account', async () => {
    const { calls, instructions } = await handshake({
      accountId: 'acct_5',
      answered: true,
    });
    assert.deepEqual(calls, []);
    assert.doesNotMatch(instructions, PROMPT);
    assert.doesNotMatch(instructions, /CONTRIBUTING BACK IS OPTIONAL/);
  });
});
