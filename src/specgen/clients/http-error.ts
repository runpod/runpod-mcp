// Shared error type for the non-SDK clients (runtime, GraphQL, SSE): carries
// the HTTP status and the response body so tool handlers can map it onto a
// ToolResult instead of leaking a bare exception to the MCP client.
//
// `upstream` is true only when Runpod answered with a non-OK HTTP response:
// runTool then puts `status` in the tool result payload. An error the MCP
// raises itself (no request sent, a deadline, a GraphQL error on an HTTP 200)
// leaves it false, so a client never reads it as a Runpod rejection.

export class HttpError extends Error {
  readonly upstream: boolean;

  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown = undefined,
    options: { upstream?: boolean } = {}
  ) {
    super(message);
    this.name = 'HttpError';
    this.upstream = options.upstream ?? false;
  }
}

// The one message for a credential-less call on a credentialed surface. Every
// client throws this instead of sending `Bearer undefined` or a silently
// unauthenticated request — runTool maps it onto a 401 tool result.
export function missingKeyError(): HttpError {
  return new HttpError(
    'No Runpod API key: the request carried no usable credential.',
    401
  );
}
