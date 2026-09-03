---
'@runpod/mcp-server': minor
---

Anonymous usage analytics on the hosted path (PostHog), off by default: enabled only when the deployment sets POSTHOG_API_KEY, never on local stdio. One event per tool call carrying tool name, status, duration, transport, and server version — never the API key, tool arguments, or resource data; the caller id is an irreversible salted HMAC. Clients opt out per request with the `X-Runpod-Analytics: off` header.
