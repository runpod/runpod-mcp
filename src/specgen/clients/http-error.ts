// Shared error type for the non-SDK clients (runtime, GraphQL, SSE): carries
// the HTTP status and the response body so tool handlers can map it onto a
// ToolResult instead of leaking a bare exception to the MCP client.

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown = undefined
  ) {
    super(message);
    this.name = 'HttpError';
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
