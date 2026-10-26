import compression from 'compression';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Only installed for SDK requests configured to answer as JSON. The SDK puts
// Content-Type directly in writeHead(), so the default getHeader()-based filter
// cannot see it. The SDK also writes headers before the body, which means a
// length threshold cannot be applied here without buffering the response.
const compressJson = compression({ threshold: 0, filter: () => true });

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
