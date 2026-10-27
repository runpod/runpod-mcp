---
'@runpod/mcp-server': minor
---

Export the hosted-service surface as `@runpod/mcp-server/hosted` (`handleMcpRequest`, `getBaseUrl`, `handleAlpSubmit`, `handleAlpJournalRead`, `handleSearch`, `DIRECTORY_PATH`) and the ALP contract the Convex sink shares as `@runpod/mcp-server/alp` (`ALP_ROUTES`, `ONCE_PER_ACCOUNT_ROUTES`, `isOncePerAccountRoute`, `scrubSubmission` and friends), so an HTTP host and its Convex functions can build on the package instead of `src/`.
