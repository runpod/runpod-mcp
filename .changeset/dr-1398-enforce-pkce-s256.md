---
'@runpod/mcp-server': minor
---

Enforce PKCE (S256) in every hosted OAuth flow. `/authorize` rejects missing, malformed, or non-S256 challenges before issuing a code and forwards a valid challenge to the flash backend. `/token` requires a valid, matching `code_verifier` before returning the minted key; missing PKCE state, `plain`, and non-matching verifiers are rejected.

Requires the backend `codeChallenge` / `codeChallengeMethod` fields on `createFlashAuthRequest` / `flashAuthRequestStatus` (runpod/RunPod, DR-1398) to be deployed.
