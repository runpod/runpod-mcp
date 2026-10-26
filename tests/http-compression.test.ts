import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type RequestOptions,
} from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { handleMcpRequest } from '#src/http';
import { enableMcpCompression } from '#src/http-compression';
import handler from '../api/index.js';

const toolsList = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {},
});

type HttpResponse = {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

function send(
  port: number,
  options: RequestOptions,
  body?: string
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ port, ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      );
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function callMcp(
  acceptEncoding?: string,
  body = toolsList,
  useVercelRoute = false,
  bearerToken: string | null = 'rpa_test'
): Promise<HttpResponse> {
  const server = createServer((req, res) => {
    if (useVercelRoute) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        // Vercel supplies its parsed request body before calling the handler.
        (req as typeof req & { body: unknown }).body = JSON.parse(
          Buffer.concat(chunks).toString()
        );
        void handler(req as never, res as never).catch((error: unknown) => {
          res.destroy(
            error instanceof Error ? error : new Error(String(error))
          );
        });
      });
      return;
    }
    void handleMcpRequest(req, res, {
      verifyCredential: async () => ({ status: 'valid' }),
    }).catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return await send(
      address.port,
      {
        method: 'POST',
        path: '/',
        headers: {
          ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(acceptEncoding ? { 'accept-encoding': acceptEncoding } : {}),
        },
      },
      body
    );
  } finally {
    server.close();
  }
}

async function callWithCompressionMiddleware(
  status: number,
  contentType: string,
  body: string
): Promise<HttpResponse> {
  const server = createServer((req, res) => {
    enableMcpCompression(req, res);
    res.writeHead(status, { 'Content-Type': contentType });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return await send(address.port, {
      headers: { 'accept-encoding': 'gzip' },
    });
  } finally {
    server.close();
  }
}

describe('hosted MCP JSON compression', () => {
  it('gzips a real tools/list response when the client accepts gzip', async () => {
    const response = await callMcp('gzip');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'application/json');
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.match(String(response.headers.vary), /Accept-Encoding/i);

    const decoded = gunzipSync(response.body);
    const parsed = JSON.parse(decoded.toString()) as {
      result: { tools: unknown[] };
    };
    assert.ok(parsed.result.tools.length > 10);
    assert.ok(response.body.length < decoded.length / 2);
  });

  it('returns readable JSON when no encoding was requested', async () => {
    const response = await callMcp();
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    const parsed = JSON.parse(response.body.toString()) as {
      result: { tools: unknown[] };
    };
    assert.ok(parsed.result.tools.length > 10);
  });

  it('supports Brotli when the client requests it', async () => {
    const response = await callMcp('br');
    assert.equal(response.headers['content-encoding'], 'br');
    const parsed = JSON.parse(
      brotliDecompressSync(response.body).toString()
    ) as {
      result: { tools: unknown[] };
    };
    assert.ok(parsed.result.tools.length > 10);
  });

  it('does not compress a response-holding SSE tool call', async () => {
    const response = await callMcp(
      'gzip',
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get-job-status', arguments: {} },
      })
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream');
    assert.equal(response.headers['content-encoding'], undefined);
    assert.match(response.body.toString(), /^event: message\ndata: /m);
  });

  it('does not compress a JSON authentication error', async () => {
    // Compression is installed after the auth gate. With threshold zero, even
    // this short body would compress if middleware leaked into this path.
    const response = await callMcp('gzip', toolsList, false, null);
    assert.equal(response.status, 401);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.headers.vary, undefined);
    assert.match(response.body.toString(), /Authorization/);
  });

  it('does not compress a large non-200 JSON response', async () => {
    const response = await callWithCompressionMiddleware(
      422,
      'application/json',
      JSON.stringify({ message: 'x'.repeat(4096) })
    );
    assert.equal(response.status, 422);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.ok(response.body.length > 4096);
    assert.deepEqual(JSON.parse(response.body.toString()), {
      message: 'x'.repeat(4096),
    });
  });

  it('does not compress a large non-JSON response', async () => {
    const body = 'x'.repeat(4096);
    const response = await callWithCompressionMiddleware(
      200,
      'text/plain',
      body
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.body.toString(), body);
  });

  it('leaves an empty notification response untouched', async () => {
    const response = await callMcp(
      'gzip',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    );
    assert.equal(response.status, 202);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(response.body.length, 0);
  });

  it('enables compression through the hosted Vercel route', async () => {
    const previous = process.env.MCP_SKIP_CREDENTIAL_CHECK;
    process.env.MCP_SKIP_CREDENTIAL_CHECK = 'true';
    try {
      const response = await callMcp('gzip', toolsList, true);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers['content-encoding'],
        'gzip',
        JSON.stringify(response.headers)
      );
      const parsed = JSON.parse(gunzipSync(response.body).toString()) as {
        result: { tools: unknown[] };
      };
      assert.ok(parsed.result.tools.length > 10);
    } finally {
      if (previous === undefined) delete process.env.MCP_SKIP_CREDENTIAL_CHECK;
      else process.env.MCP_SKIP_CREDENTIAL_CHECK = previous;
    }
  });
});
