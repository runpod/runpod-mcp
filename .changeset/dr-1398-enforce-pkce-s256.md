---
'@runpod/mcp-server': minor
---

Enforce PKCE (S256) in the hosted OAuth flow. `/authorize` now forwards the client's `code_challenge` to the flash backend, and `/token` verifies the `code_verifier` against the stored challenge before returning the minted key: a missing or non-matching verifier is rejected with `invalid_grant`, and `plain` is rejected (only S256 is advertised/accepted). Loopback redirect URIs now require PKCE (the native-app interception case it protects); hosted exact-match redirects may still use the legacy non-PKCE flow.

Requires the backend `codeChallenge` / `codeChallengeMethod` fields on `createFlashAuthRequest` / `flashAuthRequestStatus` (runpod/RunPod, DR-1398) to be deployed.
