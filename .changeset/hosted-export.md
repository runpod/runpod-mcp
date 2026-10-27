---
'@runpod/mcp-server': minor
---

Export the hosted-service surface as `@runpod/mcp-server/hosted` (`handleMcpRequest`, `getBaseUrl`, `handleAlpSubmit`, `handleAlpJournalRead`, `handleSearch`, `scrubSubmission`, `ALP_ROUTES`, `ONCE_PER_ACCOUNT_ROUTES`, `isOncePerAccountRoute`, `DIRECTORY_PATH`) so an HTTP host and its Convex functions can build on the package instead of `src/`.
