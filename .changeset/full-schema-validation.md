---
'@runpod/mcp-server': minor
---

Check every tool call against the tool's full input schema: types, enums, ranges and nested fields, not just top-level required and unknown arguments. By default this runs in shadow mode and only logs a `schema_violation` line (schema keywords and locations, never argument values), so no call that works today is blocked. Set `MCP_SCHEMA_VALIDATION=enforce` to reject an invalid call before any request is sent, with an `invalid_arguments` error naming each field's path, the problem, and the allowed values. With enforcement on, a shape error is no longer hidden behind an authentication failure. A `null` sent for an optional argument at any depth counts as omitted.
