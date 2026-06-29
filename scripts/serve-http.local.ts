// LOCAL DEV HELPER — boots the MCP server over HTTP so an agent can
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

// Bind to loopback only. `listen(PORT)` would bind 0.0.0.0 (all interfaces),
// which on a cloud VM or CI runner is reachable from outside the host — this is
// a local dev helper that holds per-request keys, so keep it off the network.
server.listen(PORT, '127.0.0.1', () => {
  console.error(
    `MCP HTTP server listening on http://localhost:${PORT}/  ` +
      `(RUNPOD_REST_VERSION=${process.env.RUNPOD_REST_VERSION ?? 'v2(default)'}, ` +
      `v2 base=${process.env.RUNPOD_REST_V2_API_URL ?? 'prod default'})`
  );
});
