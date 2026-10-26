import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { handleMcpRequest } from '#src/http';
import handler from '../api/index.js';

const toolsList = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/list',
  params: {},
});

async function callMcp(
  acceptEncoding?: string,
  body = toolsList,
  useVercelRoute = false,
  bearerToken: string | null = 'rpa_test'
): Promise<{
  status: number | undefined;
  headers: IncomingHttpHeaders;
  body: Buffer;
}> {
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
    return await new Promise((resolve, reject) => {
      const req = request(
        {
          port: address.port,
          method: 'POST',
          path: '/',
          headers: {
            ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(acceptEncoding ? { 'accept-encoding': acceptEncoding } : {}),
          },
        },
        (res) => {
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
        }
      );
      req.on('error', reject);
      req.end(body);
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
    const response = await callMcp('gzip', toolsList, false, null);
    assert.equal(response.status, 401);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.match(response.body.toString(), /Authorization/);
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
