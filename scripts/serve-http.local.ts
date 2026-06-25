// LOCAL DEV ONLY (uncommitted) — boots the MCP server over HTTP so an agent can
// connect at http://localhost:<PORT>/. The caller's Runpod API key is passed as
// the request Bearer token (this process holds no credential). v2 is controlled
// by this process's RUNPOD_REST_VERSION / RUNPOD_REST_V2_API_URL env.
import { createServer } from 'node:http';
import { handleMcpRequest } from '../src/http.js';

const PORT = Number(process.env.PORT ?? 3399);

const server = createServer((req, res) => {
  handleMcpRequest(req, res, { serverVersion: 'local-dev' }).catch((err) => {
    console.error('mcp handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    }
  });
});

server.listen(PORT, () => {
  console.error(
    `MCP HTTP server listening on http://localhost:${PORT}/  ` +
      `(RUNPOD_REST_VERSION=${process.env.RUNPOD_REST_VERSION ?? 'v1(default)'}, ` +
      `v2 base=${process.env.RUNPOD_REST_V2_API_URL ?? 'prod default'})`
  );
});
