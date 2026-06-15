---
"@runpod/mcp-server": minor
---

Address hosted OAuth review feedback:

- Remove the `MCP_OAUTH_ENABLED` flag — the hosted HTTP server always advertises the OAuth sign-in challenge. Callers that bring their own Runpod API key as the bearer token are unaffected (they never hit the challenge).
- Default `CONSOLE_BASE_URL` to the production console (`https://console.runpod.io`) so a deploy that forgets to set it doesn't silently redirect users to localhost.
- `/token` now polls for most of the function budget (~45s) instead of returning a non-retryable `authorization_pending` after ~10s, avoiding a dead-end when console→backend approval propagation lags.
- Caller-tracking falls back to the inbound HTTP `User-Agent` on the stateless HTTP transport, where the per-request server never sees the MCP `initialize` `clientInfo` (previously reported `client=unknown`).
- Stop advertising PKCE (`S256`) since it isn't enforced server-side; security rests on the `redirect_uri` allowlist and the single-use flash approval.

- Default the minted key name to `runpod-mcp` (`RUNPOD_API_KEY_NAME`), so hosted keys are identifiable/revocable. Set `RUNPOD_API_KEY_NAME=""` to suppress it for a backend that has not shipped the `apiKeyName` argument.
