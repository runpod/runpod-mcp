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
