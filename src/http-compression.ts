import compression from 'compression';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Only installed for SDK requests configured to answer as JSON. on-headers
// exposes the headers passed to writeHead() before this filter runs. The SDK
// writes headers before the body, so a size threshold cannot be applied here
// without buffering the response.
const compressJson = compression({
  threshold: 0,
  filter: (_req, res) =>
    res.statusCode === 200 &&
    /^application\/json(?:\s*;|$)/i.test(
      String(res.getHeader('Content-Type') ?? '')
    ),
});

export function enableMcpCompression(
  req: IncomingMessage,
  res: ServerResponse
): void {
  compressJson(
    req as Parameters<typeof compressJson>[0],
    res as Parameters<typeof compressJson>[1],
    () => {}
  );
}
