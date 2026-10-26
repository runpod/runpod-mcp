import compression from 'compression';
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';

// The MCP SDK passes Content-Type directly to writeHead(). The compression
// middleware reads getHeader(), so make that value visible before it chooses
// an encoding. Only complete JSON responses are eligible; SSE must stay live.
const compressJson = compression({
  threshold: 1024,
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

  const writeHead = res.writeHead.bind(res);
  res.writeHead = function (
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders,
    headers?: OutgoingHttpHeaders
  ): ServerResponse {
    // on-headers runs before Node updates statusCode in writeHead().
    res.statusCode = statusCode;
    const responseHeaders =
      typeof statusMessageOrHeaders === 'string'
        ? headers
        : statusMessageOrHeaders;
    const contentType = Object.entries(responseHeaders ?? {}).find(
      ([name]) => name.toLowerCase() === 'content-type'
    )?.[1];
    if (contentType !== undefined) res.setHeader('Content-Type', contentType);

    if (typeof statusMessageOrHeaders === 'string') {
      return writeHead(statusCode, statusMessageOrHeaders, headers);
    }
    if (statusMessageOrHeaders) {
      return writeHead(statusCode, statusMessageOrHeaders);
    }
    return writeHead(statusCode);
  } as ServerResponse['writeHead'];
}
