---
'@runpod/mcp-server': patch
---

Preserve empty-body HTTP errors in endpoint/template lists so invalid credentials trigger re-authentication. Stop job polling on permanent client errors and rate limits instead of reporting success with cold-start advice. Carry header-derived rate-limit wait hints through curated lists, GraphQL calls, and log reads.
