import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as http from 'node:http';
import { createRunpodServer } from './index.js';

// The RunPod API to validate keys against — set per stage via RUNPOD_GRAPHQL_URL env var.
// Dev stage → api.runpod.dev (dev keys only)
// Prod stage → api.runpod.io (prod keys)
const GRAPHQL_URL = process.env.RUNPOD_GRAPHQL_URL ?? 'https://api.runpod.io/graphql';

async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: '{ myself { id } }' }),
    });
    if (!res.ok) return false;
    const json = await res.json() as { data?: { myself?: { id: string } }; errors?: unknown[] };
    return !!json.data?.myself?.id;
  } catch {
    return false;
  }
}

export function createRequestHandler(): http.RequestListener {
  return async (req, res) => {
    // Health check
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'runpod-mcp' }));
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost`);

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. MCP endpoint is /mcp' }));
      return;
    }

    // Extract API key from Authorization header or ?token= query param
    const authHeader = req.headers.authorization;
    const tokenParam = url.searchParams.get('token');
    const apiKey = authHeader?.replace(/^Bearer\s+/i, '') ?? tokenParam ?? '';

    if (!apiKey) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Missing RunPod API key. Provide Authorization: Bearer <key> or ?token=<key>',
      }));
      return;
    }

    // Validate key against the configured RunPod API (dev or prod).
    // Dev stage points to api.runpod.dev — dev keys pass, prod keys 401.
    const valid = await validateApiKey(apiKey);
    if (!valid) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Invalid or unauthorized API key. This endpoint requires a ${GRAPHQL_URL.includes('runpod.dev') ? 'dev' : 'prod'} RunPod API key.`,
      }));
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    // One server + transport per request — stateless
    const server = createRunpodServer(apiKey);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
