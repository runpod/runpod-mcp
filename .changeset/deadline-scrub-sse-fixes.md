---
'@runpod/mcp-server': patch
---

Four fixes found in review of the hosted server. The SDK request deadline now spans all retry attempts instead of restarting per attempt, so three slow upstream failures can no longer run past the hosted invocation budget. ALP redaction now removes the whole value of sensitive headers (`Authorization: Basic …`, `Cookie: …`) instead of only their first token, and recognizes qualified key names with any prefix (`SERVICE_API_KEY`), without regressing to substring matching. Bounded log snapshots keep a complete final entry when the byte cap lands on an event boundary, and drop a partial one even when it ends in a newline.
