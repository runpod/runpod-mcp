---
'@runpod/mcp-server': patch
---

Accept ChatGPT's OAuth callbacks on the hosted server: the stable `https://chatgpt.com/connector_platform_oauth_redirect` and the per-connection `https://chatgpt.com/connector/oauth/{callback_id}`, so ChatGPT and Codex can sign in with Runpod.
