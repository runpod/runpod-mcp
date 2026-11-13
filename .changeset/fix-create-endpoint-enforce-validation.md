---
'@runpod/mcp-server': patch
---

Fix `create-endpoint` being rejected under `MCP_SCHEMA_VALIDATION=enforce`. The validator reported every field of a valid queue endpoint body as an unevaluated property, because of how Ajv handles an `if`/`then` placed beside `unevaluatedProperties`. The generator now moves such conditionals into an `allOf` member, which means the same thing and validates correctly. `create-pod` gets the same reshaping. A new test checks every request-body example in the API spec against full-schema validation.
