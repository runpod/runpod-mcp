// The text of every JSON tool result: the server sends it and the page
// budget (pagination.ts) measures it, so a page is measured as sent.
//
// Compact by default: indentation carries no information but costs tokens
// (docs/configuration.md). MCP_PRETTY_RESPONSES=true
// switches back to two-space indentation, for people reading raw output.

export const serializeResult = (payload: unknown): string =>
  process.env.MCP_PRETTY_RESPONSES === 'true'
    ? JSON.stringify(payload, null, 2)
    : JSON.stringify(payload);
